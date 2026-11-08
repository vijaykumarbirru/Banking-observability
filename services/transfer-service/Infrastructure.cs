using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using RabbitMQ.Client;

namespace VijayBank.Transfers;

/// <summary>Per-request values, available to outgoing HTTP calls and events.</summary>
public static class RequestContext
{
    private static readonly AsyncLocal<string?> requestId = new();
    public static string? RequestId { get => requestId.Value; set => requestId.Value = value; }
}

/// <summary>An error that maps directly to the standard {"error": {...}} body.</summary>
public sealed class ApiException(int status, string code, string message, Dictionary<string, object?>? details = null)
    : Exception(message)
{
    public int Status { get; } = status;
    public string Code { get; } = code;
    public Dictionary<string, object?> Details { get; } = details ?? [];
}

/// <summary>Forwards X-Request-Id on every outgoing call.</summary>
public sealed class RequestIdHandler : DelegatingHandler
{
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        if (RequestContext.RequestId is { } rid)
        {
            request.Headers.TryAddWithoutValidation("X-Request-Id", rid);
        }
        return base.SendAsync(request, ct);
    }
}

public sealed record AccountInfo(string AccountNo, string CustomerId, string Type, string Status, string Ifsc);
public sealed record FraudResult(int Score, string Decision, List<string> Rules);

/// <summary>Typed clients for the services transfer-service depends on.</summary>
public sealed class Downstream(IHttpClientFactory http, ILogger<Downstream> log)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public async Task<AccountInfo?> Account(string accountNo)
    {
        var res = await http.CreateClient("account").GetAsync($"/internal/accounts/{Uri.EscapeDataString(accountNo)}");
        if (res.StatusCode == HttpStatusCode.NotFound) return null;
        EnsureOk(res, "account-service");
        return await res.Content.ReadFromJsonAsync<AccountInfo>(Json);
    }

    public async Task<(string OtpRef, int ExpiresInSeconds)> SendOtp(string customerId, string purpose, object details)
    {
        var res = await http.CreateClient("auth").PostAsJsonAsync("/internal/otp/send", new { customerId, purpose, details }, Json);
        EnsureOk(res, "auth-service");
        var body = await res.Content.ReadFromJsonAsync<JsonObject>(Json);
        return (body!["otpRef"]!.GetValue<string>(), body["expiresInSeconds"]!.GetValue<int>());
    }

    /// <summary>Throws the auth-service error (INVALID_OTP, OTP_EXPIRED, ...) unchanged.</summary>
    public async Task VerifyOtp(string otpRef, string customerId, string purpose, string otp)
    {
        var res = await http.CreateClient("auth").PostAsJsonAsync("/internal/otp/verify", new { otpRef, customerId, purpose, otp }, Json);
        if ((int)res.StatusCode is >= 400 and < 500)
        {
            throw await AsApiException(res);
        }
        EnsureOk(res, "auth-service");
    }

    /// <summary>Returns null when fraud-service is unavailable; the caller decides what that means.</summary>
    public async Task<FraudResult?> Score(object features)
    {
        try
        {
            var res = await http.CreateClient("fraud").PostAsJsonAsync("/score", features, Json);
            res.EnsureSuccessStatusCode();
            return await res.Content.ReadFromJsonAsync<FraudResult>(Json);
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException)
        {
            log.LogError(e, "fraud-service unavailable");
            return null;
        }
    }

    public async Task<long?> Balance(string accountNo)
    {
        var res = await http.CreateClient("ledger").GetAsync($"/internal/balances?accounts={Uri.EscapeDataString(accountNo)}");
        EnsureOk(res, "ledger-service");
        var list = await res.Content.ReadFromJsonAsync<List<JsonObject>>(Json);
        return list is { Count: > 0 } ? list[0]["balancePaise"]!.GetValue<long>() : null;
    }

    /// <summary>Posts a two-legged journal. Ledger business errors (e.g. INSUFFICIENT_FUNDS) are rethrown as-is.</summary>
    public async Task<string> Post(string key, string type, string reference, string debit, string credit,
        long amountPaise, string debitNarration, string creditNarration)
    {
        var body = new
        {
            idempotencyKey = key, type, reference,
            entries = new object[]
            {
                new { accountNo = debit, direction = "DEBIT", amountPaise, narration = debitNarration },
                new { accountNo = credit, direction = "CREDIT", amountPaise, narration = creditNarration },
            },
        };
        var res = await http.CreateClient("ledger").PostAsJsonAsync("/internal/journals", body, Json);
        if ((int)res.StatusCode is >= 400 and < 500)
        {
            throw await AsApiException(res);
        }
        EnsureOk(res, "ledger-service");
        var json = await res.Content.ReadFromJsonAsync<JsonObject>(Json);
        return json!["journalId"]!.GetValue<string>();
    }

    private static void EnsureOk(HttpResponseMessage res, string service)
    {
        if (!res.IsSuccessStatusCode)
        {
            throw new ApiException(503, "DEPENDENCY_UNAVAILABLE",
                "A banking service is temporarily unavailable. Please try again shortly.",
                new() { ["dependency"] = service, ["dependencyStatus"] = (int)res.StatusCode });
        }
    }

    private static async Task<ApiException> AsApiException(HttpResponseMessage res)
    {
        var body = await res.Content.ReadFromJsonAsync<JsonObject>(Json);
        var err = body?["error"]?.AsObject();
        var details = new Dictionary<string, object?>();
        if (err != null)
        {
            foreach (var (k, v) in err)
            {
                if (k is not ("code" or "message" or "requestId")) details[k] = v?.ToString();
            }
        }
        return new ApiException((int)res.StatusCode, err?["code"]?.GetValue<string>() ?? "ERROR",
            err?["message"]?.GetValue<string>() ?? "Request failed.", details);
    }
}

/// <summary>Publishes domain events to vijaybank.events with publisher confirms.</summary>
public sealed class EventBus(IConfiguration config, ILogger<EventBus> log) : IDisposable
{
    private readonly object gate = new();
    private IConnection? connection;
    private IModel? channel;

    public void Publish(string type, string customerId, object data)
    {
        var eventId = Guid.NewGuid().ToString();
        var payload = JsonSerializer.SerializeToUtf8Bytes(new
        {
            eventId, type, occurredAt = DateTime.UtcNow, customerId, requestId = RequestContext.RequestId, data,
        }, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        var headers = new Dictionary<string, object> { ["x-request-id"] = RequestContext.RequestId ?? "" };
        using var activity = Telemetry.StartPublish("vijaybank.events", type, headers);

        lock (gate)
        {
            for (var attempt = 0; ; attempt++)
            {
                try
                {
                    var ch = Channel();
                    var props = ch.CreateBasicProperties();
                    props.Persistent = true;
                    props.ContentType = "application/json";
                    props.MessageId = eventId;
                    props.Headers = headers;
                    ch.BasicPublish("vijaybank.events", type, props, payload);
                    ch.WaitForConfirmsOrDie(TimeSpan.FromSeconds(5));
                    return;
                }
                catch (Exception e) when (attempt == 0)
                {
                    log.LogWarning(e, "publish failed, reconnecting");
                    channel = null;
                }
            }
        }
    }

    private IModel Channel()
    {
        if (channel is { IsOpen: true }) return channel;
        connection ??= Factory(config).CreateConnection("transfer-service-publisher");
        channel = connection.CreateModel();
        channel.ConfirmSelect();
        return channel;
    }

    public static ConnectionFactory Factory(IConfiguration config) => new()
    {
        HostName = config["RABBITMQ_HOST"] ?? "rabbitmq",
        UserName = config["RABBITMQ_USER"] ?? "vijaybank",
        Password = config["RABBITMQ_PASSWORD"] ?? "vijaybank_pw",
        DispatchConsumersAsync = true,
        AutomaticRecoveryEnabled = true,
    };

    public static string? Header(IBasicProperties props, string name) =>
        props.Headers != null && props.Headers.TryGetValue(name, out var v)
            ? v switch { byte[] b => Encoding.UTF8.GetString(b), _ => v?.ToString() }
            : null;

    public void Dispose()
    {
        channel?.Dispose();
        connection?.Dispose();
    }
}
