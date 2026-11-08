using System.Diagnostics;
using System.Text.Json;
using RabbitMQ.Client;
using RabbitMQ.Client.Events;

namespace VijayBank.Transfers;

/// <summary>Applies settlement results (transfer.settled / transfer.failed) to transfer status.</summary>
public sealed class StatusConsumer(Store store, IConfiguration config, ILogger<StatusConsumer> log) : BackgroundService
{
    private const string Queue = "transfer.status-updates";
    private IConnection? connection;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        for (var attempt = 1; connection is null; attempt++)
        {
            try
            {
                connection = EventBus.Factory(config).CreateConnection("transfer-service-consumer");
            }
            catch (Exception e) when (attempt < 30 && !stoppingToken.IsCancellationRequested)
            {
                log.LogWarning(e, "waiting for rabbitmq (attempt {Attempt})", attempt);
                await Task.Delay(2000, stoppingToken);
            }
        }

        var channel = connection.CreateModel();
        channel.BasicQos(0, 20, false);
        var consumer = new AsyncEventingBasicConsumer(channel);
        consumer.Received += async (_, ea) =>
        {
            using var activity = Telemetry.StartProcess(Queue, ea.BasicProperties);
            RequestContext.RequestId = EventBus.Header(ea.BasicProperties, "x-request-id");
            using var scope = log.BeginScope(new Dictionary<string, object?> { ["requestId"] = RequestContext.RequestId });
            try
            {
                using var doc = JsonDocument.Parse(ea.Body);
                var type = doc.RootElement.GetProperty("type").GetString();
                var data = doc.RootElement.GetProperty("data");
                var id = data.GetProperty("transferId").GetGuid();
                var moved = type switch
                {
                    "transfer.settled" => await store.Move(id, "PROCESSING", "COMPLETED", completed: true),
                    "transfer.failed" => await store.Move(id, "PROCESSING", "FAILED",
                        data.TryGetProperty("reason", out var r) ? r.GetString() : "SETTLEMENT_FAILED"),
                    _ => false,
                };
                log.LogInformation("status update {Type} transfer={TransferId} applied={Applied}", type, id, moved);
                channel.BasicAck(ea.DeliveryTag, false);
            }
            catch (Exception e)
            {
                activity?.SetStatus(ActivityStatusCode.Error, e.Message);
                log.LogError(e, "could not apply status update, dead-lettering");
                channel.BasicNack(ea.DeliveryTag, false, requeue: false);
            }
        };
        channel.BasicConsume(Queue, autoAck: false, consumer);
        log.LogInformation("consuming {Queue}", Queue);
        await Task.Delay(Timeout.Infinite, stoppingToken);
    }

    public override void Dispose()
    {
        connection?.Dispose();
        base.Dispose();
    }
}
