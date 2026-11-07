// transfer-service: beneficiaries, limits and the transfer workflow
// (OTP step-up -> fraud check -> ledger posting -> async settlement).
using System.Diagnostics;
using Npgsql;
using VijayBank.Transfers;

var builder = WebApplication.CreateBuilder(args);
builder.Logging.ClearProviders();
builder.Logging.AddJsonConsole(o =>
{
    o.IncludeScopes = true;
    o.UseUtcTimestamp = true;
    o.TimestampFormat = "yyyy-MM-ddTHH:mm:ss.fffZ";
});
builder.WebHost.UseUrls($"http://0.0.0.0:{builder.Configuration["PORT"] ?? "8085"}");

var cfg = builder.Configuration;
builder.Services.AddSingleton(NpgsqlDataSource.Create(
    cfg["DATABASE_URL"] ?? "Host=postgres;Database=transfer;Username=transfer_svc;Password=transfer_pw"));
builder.Services.AddSingleton<Store>();
builder.Services.AddSingleton<EventBus>();
builder.Services.AddSingleton<Downstream>();
builder.Services.AddSingleton<TransferLogic>();
builder.Services.AddHostedService<StatusConsumer>();
builder.Services.AddTransient<RequestIdHandler>();
foreach (var (name, url, timeout) in new[]
{
    ("account", cfg["ACCOUNT_URL"] ?? "http://account-service:8083", 5),
    ("auth", cfg["AUTH_URL"] ?? "http://auth-service:8081", 5),
    ("ledger", cfg["LEDGER_URL"] ?? "http://ledger-service:8084", 10),
    ("fraud", cfg["FRAUD_URL"] ?? "http://fraud-service:8086", 2),
})
{
    builder.Services.AddHttpClient(name, c =>
    {
        c.BaseAddress = new Uri(url);
        c.Timeout = TimeSpan.FromSeconds(timeout);
    }).AddHttpMessageHandler<RequestIdHandler>();
}

var app = builder.Build();
await app.Services.GetRequiredService<Store>().Migrate();
var accessLog = app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("access");

// Request context, access log and the standard error body.
app.Use(async (ctx, next) =>
{
    var rid = ctx.Request.Headers["X-Request-Id"].FirstOrDefault() ?? Guid.NewGuid().ToString("N");
    RequestContext.RequestId = rid;
    ctx.Response.Headers["X-Request-Id"] = rid;
    using var scope = accessLog.BeginScope(new Dictionary<string, object?>
    {
        ["requestId"] = rid,
        ["customerId"] = ctx.Request.Headers["X-Customer-Id"].FirstOrDefault(),
    });
    var sw = Stopwatch.StartNew();
    try
    {
        await next();
    }
    catch (ApiException e)
    {
        await WriteError(ctx, e.Status, e.Code, e.Message, e.Details);
    }
    catch (Exception e)
    {
        accessLog.LogError(e, "unhandled error");
        await WriteError(ctx, 500, "INTERNAL_ERROR", "Something went wrong. Please try again.", []);
    }
    if (!ctx.Request.Path.StartsWithSegments("/health"))
    {
        accessLog.LogInformation("request method={Method} path={Path} status={Status} durationMs={DurationMs}",
            ctx.Request.Method, ctx.Request.Path.Value, ctx.Response.StatusCode, sw.ElapsedMilliseconds);
    }
});

static Task WriteError(HttpContext ctx, int status, string code, string message, Dictionary<string, object?> details)
{
    ctx.Response.StatusCode = status;
    var error = new Dictionary<string, object?> { ["code"] = code, ["message"] = message, ["requestId"] = RequestContext.RequestId };
    foreach (var (k, v) in details) error[k] = v;
    return ctx.Response.WriteAsJsonAsync(new { error });
}

static string Customer(HttpContext ctx) =>
    ctx.Request.Headers["X-Customer-Id"].FirstOrDefault() is { Length: > 0 } c
        ? c
        : throw new ApiException(401, "UNAUTHENTICATED", "Login required.");

app.MapGet("/health/live", () => Results.Ok(new { status = "UP" }));
app.MapGet("/health/ready", async (Store store) =>
    await store.Ping() ? Results.Ok(new { status = "UP" }) : Results.Json(new { status = "DOWN" }, statusCode: 503));

// Beneficiaries
app.MapGet("/beneficiaries", async (HttpContext ctx, Store store) =>
    (await store.Beneficiaries(Customer(ctx))).Select(View.Of));

app.MapPost("/beneficiaries", async (HttpContext ctx, AddBeneficiaryRequest req, TransferLogic logic) =>
{
    var b = await logic.AddBeneficiary(Customer(ctx), req);
    return Results.Json(new { beneficiary = View.Of(b), status = "OTP_REQUIRED" }, statusCode: 202);
});

app.MapPost("/beneficiaries/{id:guid}/confirm", async (HttpContext ctx, Guid id, OtpRequest req, TransferLogic logic) =>
    View.Of(await logic.ConfirmBeneficiary(Customer(ctx), id, req.Otp)));

app.MapDelete("/beneficiaries/{id:guid}", async (HttpContext ctx, Guid id, Store store) =>
    await store.DeleteBeneficiary(id, Customer(ctx))
        ? Results.NoContent()
        : throw new ApiException(404, "NOT_FOUND", "Beneficiary not found."));

// Transfers
app.MapPost("/transfers", async (HttpContext ctx, CreateTransferRequest req, TransferLogic logic) =>
{
    var (t, replayed) = await logic.Create(Customer(ctx), ctx.Request.Headers["Idempotency-Key"].FirstOrDefault(), req);
    return Results.Json(View.Of(t), statusCode: replayed ? 200 : 202);
});

app.MapPost("/transfers/{id:guid}/confirm", async (HttpContext ctx, Guid id, OtpRequest req, TransferLogic logic) =>
    View.Of(await logic.Confirm(Customer(ctx), id, req.Otp)));

app.MapGet("/transfers/{id:guid}", async (HttpContext ctx, Guid id, Store store) =>
    await store.Transfer(id, Customer(ctx)) is { } t ? View.Of(t) : throw new ApiException(404, "NOT_FOUND", "Transfer not found."));

app.MapGet("/transfers", async (HttpContext ctx, Store store, int? limit) =>
    (await store.Transfers(Customer(ctx), Math.Clamp(limit ?? 20, 1, 100))).Select(View.Of));

app.MapGet("/transfers/limits", async (HttpContext ctx, TransferLogic logic) => await logic.Limits(Customer(ctx)));

// Internal: used by the seed job.
app.MapPost("/internal/beneficiaries", async (SeedBeneficiaryRequest req, TransferLogic logic) =>
{
    await logic.SeedBeneficiary(req);
    return Results.Ok(new { created = true });
});

app.Run();
