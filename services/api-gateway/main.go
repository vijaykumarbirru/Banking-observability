// api-gateway: the only entry point for the browser. Routes /api/* to the
// owning service, validates the customer's JWT, rate-limits per client IP and
// stamps every request with an X-Request-Id.
package main

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/redis/go-redis/v9"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)).With("service", "api-gateway"))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	rdb := redis.NewClient(&redis.Options{Addr: env("REDIS_ADDR", "redis:6379")})
	keys := newJWKS(env("AUTH_JWKS_URL", "http://auth-service:8081/.well-known/jwks.json"))

	auth := proxy(env("AUTH_URL", "http://auth-service:8081"))
	customer := proxy(env("CUSTOMER_URL", "http://customer-service:8082"))
	account := proxy(env("ACCOUNT_URL", "http://account-service:8083"))
	notification := proxy(env("NOTIFICATION_URL", "http://notification-service:8087"))
	transfer := proxy(env("TRANSFER_URL", "http://transfer-service:8085"))
	statement := proxy(env("STATEMENT_URL", "http://statement-service:8089"))
	payment := proxy(env("PAYMENT_URL", "http://payment-service:8090"))
	card := proxy(env("CARD_URL", "http://card-service:8091"))

	rps, _ := strconv.ParseFloat(env("RATE_LIMIT_RPS", "20"), 64)
	burst, _ := strconv.Atoi(env("RATE_LIMIT_BURST", "40"))

	r := chi.NewRouter()
	r.Use(requestID, accessLog, middleware.Recoverer)
	r.Get("/health/live", func(w http.ResponseWriter, _ *http.Request) { writeJSON(w, 200, map[string]string{"status": "UP"}) })
	r.Get("/health/ready", func(w http.ResponseWriter, r *http.Request) {
		if err := rdb.Ping(r.Context()).Err(); err != nil {
			writeJSON(w, 503, map[string]string{"status": "DOWN"})
			return
		}
		writeJSON(w, 200, map[string]string{"status": "UP"})
	})

	r.Route("/api", func(api chi.Router) {
		api.Use(newRateLimiter(rps, burst).middleware)

		// Public: no session yet.
		api.Post("/auth/login", auth)
		api.Post("/auth/otp/verify", auth)
		api.Post("/auth/refresh", auth)
		// Lab-only simulated SMS inbox; disabled with DEV_INBOX_ENABLED=false.
		if env("DEV_INBOX_ENABLED", "true") == "true" {
			api.Get("/notifications/dev-inbox", notification)
		}

		// Everything else needs a valid access token.
		api.Group(func(p chi.Router) {
			p.Use(authenticate(keys, rdb))
			p.Post("/auth/logout", auth)
			p.Handle("/customers/*", customer)
			p.Handle("/accounts", account)
			p.Handle("/accounts/*", account)
			p.Get("/accounts/{accountNo}/transactions", statement)
			p.Get("/accounts/{accountNo}/statement.pdf", statement)
			p.Get("/accounts/{accountNo}/statement.csv", statement)
			p.Handle("/beneficiaries", transfer)
			p.Handle("/beneficiaries/*", transfer)
			p.Handle("/transfers", transfer)
			p.Handle("/transfers/*", transfer)
			p.Handle("/deposits", account)
			p.Handle("/deposits/*", account)
			p.Get("/billers", payment)
			p.Handle("/bill-payments", payment)
			p.Handle("/bill-payments/*", payment)
			p.Handle("/cards", card)
			p.Handle("/cards/*", card)
			p.Get("/notifications", notification)
		})
	})
	r.NotFound(func(w http.ResponseWriter, r *http.Request) {
		writeError(w, r, 404, "NOT_FOUND", "no such endpoint")
	})

	srv := &http.Server{Addr: ":" + env("PORT", "8000"), Handler: r, ReadHeaderTimeout: 5 * time.Second}
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

// proxy forwards /api/<rest> to <target>/<rest>. The customer identity is
// taken only from the verified token, never from the client's headers.
func proxy(target string) http.HandlerFunc {
	u, err := url.Parse(target)
	if err != nil {
		panic(err)
	}
	rp := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(u)
			pr.Out.URL.Path = strings.TrimPrefix(pr.In.URL.Path, "/api")
			pr.Out.URL.RawPath = ""
			pr.SetXForwarded()
			pr.Out.Header.Del("X-Customer-Id")
			if cid := customerID(pr.In); cid != "" {
				pr.Out.Header.Set("X-Customer-Id", cid)
			}
			pr.Out.Header.Set("X-Request-Id", reqID(pr.In))
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			slog.Error("upstream unavailable", "requestId", reqID(r), "upstream", target, "error", err)
			writeError(w, r, 502, "UPSTREAM_UNAVAILABLE", "service temporarily unavailable")
		},
	}
	return rp.ServeHTTP
}
