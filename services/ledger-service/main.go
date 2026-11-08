// ledger-service: double-entry ledger and balances — the single source of
// truth for money. Internal only; never exposed through the API gateway.
package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"regexp"
	"strings"
	"syscall"
	"time"

	"github.com/exaring/otelpgx"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5/pgxpool"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	slog.SetDefault(slog.New(traceHandler{slog.NewJSONHandler(os.Stdout, nil)}).With("service", "ledger-service"))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	otelShutdown := setupOTel(ctx)
	defer func() {
		flush, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = otelShutdown(flush)
	}()

	pool, err := connect(ctx, env("DATABASE_URL", "postgres://ledger_svc:ledger_pw@postgres:5432/ledger"))
	if err != nil {
		slog.Error("database unavailable", "error", err)
		os.Exit(1)
	}
	defer pool.Close()

	if err := migrate(ctx, pool); err != nil {
		slog.Error("migration failed", "error", err)
		os.Exit(1)
	}

	h := &handlers{db: pool}
	r := chi.NewRouter()
	r.Use(requestID, spanName, accessLog, middleware.Recoverer)
	r.Get("/health/live", func(w http.ResponseWriter, _ *http.Request) { writeJSON(w, 200, map[string]string{"status": "UP"}) })
	r.Get("/health/ready", h.ready)
	r.Route("/internal", func(r chi.Router) {
		r.Post("/ledger-accounts", h.createAccount)
		r.Post("/journals", h.postJournal)
		r.Get("/balances", h.balances)
		r.Get("/accounts/{accountNo}/entries", h.entries)
		r.Get("/accounts/{accountNo}/summary", h.summary)
	})

	srv := &http.Server{Addr: ":" + env("PORT", "8084"), Handler: instrument(r), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		slog.Info("listening", "addr", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("server failed", "error", err)
			os.Exit(1)
		}
	}()
	<-ctx.Done()
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdown)
}

// connect retries for a while, so the service survives starting before Postgres.
func connect(ctx context.Context, url string) (*pgxpool.Pool, error) {
	var lastErr error
	for i := 0; i < 30; i++ {
		pool, err := newPool(ctx, url)
		if err == nil {
			if err = pool.Ping(ctx); err == nil {
				return pool, nil
			}
			pool.Close()
		}
		lastErr = err
		slog.Warn("waiting for database", "attempt", i+1, "error", err)
		time.Sleep(2 * time.Second)
	}
	return nil, lastErr
}

// newPool records every query as a span (SQL text in db.statement, values are not recorded).
func newPool(ctx context.Context, url string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, err
	}
	cfg.ConnConfig.Tracer = otelpgx.NewTracer(otelpgx.WithTrimSQLInSpanName(), otelpgx.WithSpanNameFunc(sqlSpanName),
		otelpgx.WithDisableQuerySpanNamePrefix())
	return pgxpool.NewWithConfig(ctx, cfg)
}

var sqlTable = regexp.MustCompile(`(?i)^\s*UPDATE\s+(\w+)|\b(?:FROM|INTO)\s+(\w+)`)

// sqlSpanName names a query span "SELECT ledger_accounts", "INSERT entries" or
// "BEGIN", so APM groups queries by operation and table instead of full SQL.
func sqlSpanName(stmt string) string {
	words := strings.Fields(stmt)
	if len(words) == 0 {
		return "query"
	}
	op := strings.ToUpper(words[0])
	if m := sqlTable.FindStringSubmatch(stmt); m != nil {
		return op + " " + m[1] + m[2]
	}
	return op
}
