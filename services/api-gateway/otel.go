package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/contrib/instrumentation/runtime"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

// setupOTel sends traces and metrics over OTLP when OTEL_EXPORTER_OTLP_ENDPOINT
// is set (docker-compose.observability.yml). Without it the global no-op
// providers stay in place, so the service runs the same without the
// observability stack. The exporters read the standard OTEL_* variables.
func setupOTel(ctx context.Context) (shutdown func(context.Context) error) {
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(propagation.TraceContext{}, propagation.Baggage{}))
	if os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT") == "" {
		return func(context.Context) error { return nil }
	}
	res, _ := resource.Merge(resource.Default(), resource.Environment()) // OTEL_SERVICE_NAME, OTEL_RESOURCE_ATTRIBUTES

	traceExp, err := otlptracehttp.New(ctx)
	if err != nil {
		slog.Error("otel trace exporter", "error", err)
		return func(context.Context) error { return nil }
	}
	tp := sdktrace.NewTracerProvider(sdktrace.WithBatcher(traceExp), sdktrace.WithResource(res),
		sdktrace.WithSampler(dropOrphanClients{sdktrace.ParentBased(sdktrace.AlwaysSample())}))
	otel.SetTracerProvider(tp)

	metricExp, err := otlpmetrichttp.New(ctx)
	if err != nil {
		slog.Error("otel metric exporter", "error", err)
		return tp.Shutdown
	}
	mp := sdkmetric.NewMeterProvider(sdkmetric.WithResource(res),
		sdkmetric.WithReader(sdkmetric.NewPeriodicReader(metricExp, sdkmetric.WithInterval(30*time.Second))))
	otel.SetMeterProvider(mp)
	_ = runtime.Start() // Go memory, GC and goroutine metrics

	return func(ctx context.Context) error { return errors.Join(tp.Shutdown(ctx), mp.Shutdown(ctx)) }
}

// dropOrphanClients skips client spans that have no parent: connection-pool
// pings and health-check queries, which would otherwise fill Tempo with
// one-span traces.
type dropOrphanClients struct{ sdktrace.Sampler }

func (s dropOrphanClients) ShouldSample(p sdktrace.SamplingParameters) sdktrace.SamplingResult {
	if p.Kind == trace.SpanKindClient && !trace.SpanContextFromContext(p.ParentContext).IsValid() {
		return sdktrace.SamplingResult{Decision: sdktrace.Drop}
	}
	return s.Sampler.ShouldSample(p)
}

func (s dropOrphanClients) Description() string { return "DropOrphanClients" }

// instrument starts a server span for every request except health checks and
// continues the caller's trace from the traceparent header.
func instrument(h http.Handler) http.Handler {
	return otelhttp.NewHandler(h, "http.server",
		otelhttp.WithFilter(func(r *http.Request) bool { return !strings.HasPrefix(r.URL.Path, "/health/") }),
		otelhttp.WithSpanNameFormatter(func(_ string, r *http.Request) string { return r.Method }))
}

// spanName renames the server span to the matched route ("GET /internal/journals")
// once chi has routed the request, so traces and APM group by endpoint, not raw path.
func spanName(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r)
		if p := chi.RouteContext(r.Context()).RoutePattern(); p != "" {
			span := trace.SpanFromContext(r.Context())
			span.SetName(r.Method + " " + p)
			span.SetAttributes(attribute.String("http.route", p))
		}
	})
}

// traceHandler adds trace_id and span_id to every log line written with a
// request context (slog.InfoContext etc.), so Kibana lines link to traces.
type traceHandler struct{ slog.Handler }

func (h traceHandler) Handle(ctx context.Context, r slog.Record) error {
	if sc := trace.SpanContextFromContext(ctx); sc.IsValid() {
		r.AddAttrs(slog.String("trace_id", sc.TraceID().String()), slog.String("span_id", sc.SpanID().String()))
	}
	return h.Handler.Handle(ctx, r)
}

func (h traceHandler) WithAttrs(as []slog.Attr) slog.Handler {
	return traceHandler{h.Handler.WithAttrs(as)}
}
func (h traceHandler) WithGroup(n string) slog.Handler { return traceHandler{h.Handler.WithGroup(n)} }
