using System.Diagnostics;
using System.Text;
using OpenTelemetry;
using OpenTelemetry.Context.Propagation;
using OpenTelemetry.Metrics;
using OpenTelemetry.Trace;
using RabbitMQ.Client;

namespace VijayBank.Settlement;

/// <summary>
/// OpenTelemetry traces and metrics over OTLP, and trace propagation through
/// RabbitMQ message headers (RabbitMQ.Client 6 has no tracing of its own).
/// </summary>
public static class Telemetry
{
    public static readonly ActivitySource Source = new("VijayBank.Settlement");

    /// <summary>Exports only when OTEL_EXPORTER_OTLP_ENDPOINT is set (docker-compose.observability.yml);
    /// the exporter reads the standard OTEL_* variables, including OTEL_SERVICE_NAME.</summary>
    public static void AddTelemetry(this WebApplicationBuilder builder)
    {
        // Every log line carries TraceId/SpanId in its scopes, so Kibana lines link to traces.
        builder.Logging.Configure(o => o.ActivityTrackingOptions = ActivityTrackingOptions.TraceId | ActivityTrackingOptions.SpanId);
        if (string.IsNullOrEmpty(builder.Configuration["OTEL_EXPORTER_OTLP_ENDPOINT"])) return;
        // The exporters' own HttpClient would log ~6 lines per export batch.
        builder.Logging.AddFilter("System.Net.Http.HttpClient.Otlp", LogLevel.Warning);

        builder.Services.AddOpenTelemetry()
            .WithTracing(t => t
                .SetSampler(new DropOrphanClients())
                .AddSource(Source.Name)
                .AddAspNetCoreInstrumentation(o => o.Filter = ctx => !ctx.Request.Path.StartsWithSegments("/health"))
                .AddHttpClientInstrumentation()
                .AddOtlpExporter())
            .WithMetrics(m => m
                .AddAspNetCoreInstrumentation()
                .AddHttpClientInstrumentation()
                .AddRuntimeInstrumentation()
                .AddOtlpExporter());
    }

    /// <summary>Starts a producer span and writes its traceparent into the message headers.</summary>
    public static Activity? StartPublish(string exchange, string routingKey, IDictionary<string, object> headers)
    {
        var activity = Source.StartActivity($"{routingKey} publish", ActivityKind.Producer);
        activity?.SetTag("messaging.system", "rabbitmq");
        activity?.SetTag("messaging.operation", "publish");
        activity?.SetTag("messaging.destination.name", exchange);
        activity?.SetTag("messaging.rabbitmq.destination.routing_key", routingKey);
        var context = activity?.Context ?? Activity.Current?.Context ?? default;
        Propagators.DefaultTextMapPropagator.Inject(new PropagationContext(context, Baggage.Current), headers,
            (h, key, value) => h[key] = value);
        return activity;
    }

    /// <summary>Starts a consumer span that continues the publisher's trace.</summary>
    public static Activity? StartProcess(string queue, IBasicProperties props)
    {
        var parent = Propagators.DefaultTextMapPropagator.Extract(default, props, (p, key) =>
            p.Headers != null && p.Headers.TryGetValue(key, out var v)
                ? new[] { v is byte[] b ? Encoding.UTF8.GetString(b) : v?.ToString() ?? "" }
                : Array.Empty<string>());
        Baggage.Current = parent.Baggage;
        var activity = Source.StartActivity($"{queue} process", ActivityKind.Consumer, parent.ActivityContext);
        activity?.SetTag("messaging.system", "rabbitmq");
        activity?.SetTag("messaging.operation", "process");
        activity?.SetTag("messaging.destination.name", queue);
        return activity;
    }

    /// <summary>Skips client spans that have no parent (health-check queries, pool and start-up work),
    /// which would otherwise fill Tempo with one-span traces.</summary>
    private sealed class DropOrphanClients : Sampler
    {
        private readonly Sampler inner = new ParentBasedSampler(new AlwaysOnSampler());

        public override SamplingResult ShouldSample(in SamplingParameters p) =>
            p.Kind == ActivityKind.Client && p.ParentContext.TraceId == default
                ? new SamplingResult(SamplingDecision.Drop)
                : inner.ShouldSample(p);
    }
}
