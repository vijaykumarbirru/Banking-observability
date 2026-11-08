// settlement-worker: simulates the interbank networks for outward transfers.
// Consumes transfer.debited; after a mode-specific delay it either settles the
// money out of the clearing account or reverses it back to the customer, and
// publishes transfer.settled / transfer.failed.
using System.Diagnostics;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using RabbitMQ.Client;
using RabbitMQ.Client.Events;
using VijayBank.Settlement;

var builder = WebApplication.CreateBuilder(args);
builder.Logging.ClearProviders();
builder.Logging.AddJsonConsole(o =>
{
    o.IncludeScopes = true;
    o.UseUtcTimestamp = true;
    o.TimestampFormat = "yyyy-MM-ddTHH:mm:ss.fffZ";
});
builder.AddTelemetry();
builder.WebHost.UseUrls($"http://0.0.0.0:{builder.Configuration["PORT"] ?? "8092"}");
builder.Services.AddHttpClient("ledger", c =>
{
    c.BaseAddress = new Uri(builder.Configuration["LEDGER_URL"] ?? "http://ledger-service:8084");
    c.Timeout = TimeSpan.FromSeconds(10);
});
builder.Services.AddSingleton<Worker>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<Worker>());

var app = builder.Build();
app.MapGet("/health/live", () => Results.Ok(new { status = "UP" }));
app.MapGet("/health/ready", (Worker w) => w.Connected ? Results.Ok(new { status = "UP" }) : Results.Json(new { status = "STARTING" }, statusCode: 503));
app.Run();

sealed class Worker(IHttpClientFactory http, IConfiguration config, ILogger<Worker> log) : BackgroundService
{
    private const string Queue = "settlement.transfers";
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly double failureRate = config.GetValue("SETTLEMENT_FAILURE_RATE", 0.0);
    private readonly object publishGate = new();
    private IConnection? connection;
    private IModel? publishChannel;

    public bool Connected => connection is { IsOpen: true };

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var factory = new ConnectionFactory
        {
            HostName = config["RABBITMQ_HOST"] ?? "rabbitmq",
            UserName = config["RABBITMQ_USER"] ?? "vijaybank",
            Password = config["RABBITMQ_PASSWORD"] ?? "vijaybank_pw",
            DispatchConsumersAsync = true,
            AutomaticRecoveryEnabled = true,
            ConsumerDispatchConcurrency = 32, // NEFT messages wait for the next batch; don't block IMPS behind them
        };
        for (var attempt = 1; connection is null; attempt++)
        {
            try
            {
                connection = factory.CreateConnection("settlement-worker");
            }
            catch (Exception e) when (attempt < 30 && !stoppingToken.IsCancellationRequested)
            {
                log.LogWarning(e, "waiting for rabbitmq (attempt {Attempt})", attempt);
                await Task.Delay(2000, stoppingToken);
            }
        }
        publishChannel = connection.CreateModel();
        publishChannel.ConfirmSelect();

        var channel = connection.CreateModel();
        channel.BasicQos(0, 100, false);
        var consumer = new AsyncEventingBasicConsumer(channel);
        consumer.Received += async (_, ea) =>
        {
            using var activity = Telemetry.StartProcess(Queue, ea.BasicProperties);
            var requestId = ea.BasicProperties.Headers?.TryGetValue("x-request-id", out var h) == true && h is byte[] b
                ? Encoding.UTF8.GetString(b) : null;
            using var scope = log.BeginScope(new Dictionary<string, object?> { ["requestId"] = requestId });
            try
            {
                using var doc = JsonDocument.Parse(ea.Body);
                await Settle(doc.RootElement, requestId, stoppingToken);
                channel.BasicAck(ea.DeliveryTag, false);
            }
            catch (Exception e) when (!stoppingToken.IsCancellationRequested)
            {
                activity?.SetStatus(ActivityStatusCode.Error, e.Message);
                // Leave it for redelivery: every ledger posting below is idempotent.
                log.LogError(e, "settlement failed, will be redelivered");
                await Task.Delay(2000, stoppingToken);
                channel.BasicNack(ea.DeliveryTag, false, requeue: true);
            }
        };
        channel.BasicConsume(Queue, autoAck: false, consumer);
        log.LogInformation("consuming {Queue} failureRate={FailureRate}", Queue, failureRate);
        await Task.Delay(Timeout.Infinite, stoppingToken);
    }

    private async Task Settle(JsonElement evt, string? requestId, CancellationToken ct)
    {
        var customerId = evt.GetProperty("customerId").GetString()!;
        var data = evt.GetProperty("data");
        var transferId = data.GetProperty("transferId").GetString()!;
        var mode = data.GetProperty("mode").GetString()!;
        var reference = data.GetProperty("reference").GetString()!;
        var amount = data.GetProperty("amountPaise").GetInt64();
        var from = data.GetProperty("fromAccountNo").GetString()!;
        var to = data.GetProperty("toAccountNo").GetString()!;

        await Task.Delay(NetworkDelay(mode), ct);

        // Simulated destination-bank decision. Accounts ending 0000 are always rejected (handy for testing).
        string? reason = to.EndsWith("0000") ? "BENEFICIARY_ACCOUNT_INVALID"
            : Random.Shared.NextDouble() < failureRate ? "NETWORK_TIMEOUT"
            : null;

        if (reason is null)
        {
            await Post(requestId, $"settle:{transferId}", mode + "_SETTLEMENT", reference, mode + "_CLEARING", "EXTERNAL_SETTLEMENT",
                amount, $"{mode} SETTLED {reference}", $"{mode} OUTWARD {reference}", ct);
            Publish("transfer.settled", customerId, requestId, Data(data, null));
            log.LogInformation("settled {TransferId} mode={Mode}", transferId, mode);
        }
        else
        {
            await Post(requestId, $"reverse:{transferId}", mode + "_REVERSAL", reference, mode + "_CLEARING", from,
                amount, $"{mode} RETURN {reference}", $"REV/{mode}/{reference}/{reason}", ct);
            Publish("transfer.failed", customerId, requestId, Data(data, reason));
            log.LogWarning("reversed {TransferId} mode={Mode} reason={Reason}", transferId, mode, reason);
        }
    }

    /// <summary>IMPS ~1 s, RTGS ~2 s, NEFT waits for the next 30-second batch.</summary>
    private static TimeSpan NetworkDelay(string mode) => mode switch
    {
        "IMPS" => TimeSpan.FromMilliseconds(800 + Random.Shared.Next(400)),
        "RTGS" => TimeSpan.FromMilliseconds(1800 + Random.Shared.Next(400)),
        "NEFT" => TimeSpan.FromSeconds(30 - DateTime.UtcNow.Second % 30),
        _ => TimeSpan.Zero,
    };

    private async Task Post(string? requestId, string key, string type, string reference, string debit, string credit,
        long amount, string debitNarration, string creditNarration, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, "/internal/journals")
        {
            Content = JsonContent.Create(new
            {
                idempotencyKey = key, type, reference,
                entries = new object[]
                {
                    new { accountNo = debit, direction = "DEBIT", amountPaise = amount, narration = debitNarration },
                    new { accountNo = credit, direction = "CREDIT", amountPaise = amount, narration = creditNarration },
                },
            }, options: Json),
        };
        if (requestId != null) req.Headers.TryAddWithoutValidation("X-Request-Id", requestId);
        var res = await http.CreateClient("ledger").SendAsync(req, ct);
        if (!res.IsSuccessStatusCode)
        {
            throw new InvalidOperationException($"ledger returned {(int)res.StatusCode}: {await res.Content.ReadAsStringAsync(ct)}");
        }
    }

    private static Dictionary<string, object?> Data(JsonElement data, string? reason)
    {
        var d = JsonSerializer.Deserialize<Dictionary<string, object?>>(data.GetRawText())!;
        d["reason"] = reason;
        return d;
    }

    private void Publish(string type, string customerId, string? requestId, object data)
    {
        var eventId = Guid.NewGuid().ToString();
        var body = JsonSerializer.SerializeToUtf8Bytes(new
        {
            eventId, type, occurredAt = DateTime.UtcNow, customerId, requestId, data,
        }, Json);
        var headers = new Dictionary<string, object> { ["x-request-id"] = requestId ?? "" };
        using var activity = Telemetry.StartPublish("vijaybank.events", type, headers);
        lock (publishGate)
        {
            var props = publishChannel!.CreateBasicProperties();
            props.Persistent = true;
            props.ContentType = "application/json";
            props.MessageId = eventId;
            props.Headers = headers;
            publishChannel.BasicPublish("vijaybank.events", type, props, body);
            publishChannel.WaitForConfirmsOrDie(TimeSpan.FromSeconds(5));
        }
    }

    public override void Dispose()
    {
        publishChannel?.Dispose();
        connection?.Dispose();
        base.Dispose();
    }
}
