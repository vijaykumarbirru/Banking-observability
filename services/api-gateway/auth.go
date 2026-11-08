package main

import (
	"context"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/redis/go-redis/v9"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"golang.org/x/time/rate"
)

const customerIDKey ctxKey = "customerId"

func customerID(r *http.Request) string {
	id, _ := r.Context().Value(customerIDKey).(string)
	return id
}

// jwks fetches auth-service's public keys lazily and re-fetches when a token
// carries an unknown key id (auth-service generates a new key on restart).
type jwks struct {
	url       string
	mu        sync.RWMutex
	keys      map[string]*rsa.PublicKey
	lastFetch time.Time
}

func newJWKS(url string) *jwks { return &jwks{url: url, keys: map[string]*rsa.PublicKey{}} }

func (k *jwks) key(ctx context.Context, kid string) (*rsa.PublicKey, error) {
	k.mu.RLock()
	key, ok := k.keys[kid]
	k.mu.RUnlock()
	if ok {
		return key, nil
	}
	if err := k.refresh(ctx); err != nil {
		return nil, err
	}
	k.mu.RLock()
	defer k.mu.RUnlock()
	if key, ok := k.keys[kid]; ok {
		return key, nil
	}
	return nil, fmt.Errorf("unknown key id %q", kid)
}

func (k *jwks) refresh(ctx context.Context) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	if time.Since(k.lastFetch) < 5*time.Second {
		return nil // avoid hammering auth-service with bad tokens
	}
	k.lastFetch = time.Now()
	client := http.Client{Timeout: 3 * time.Second, Transport: otelhttp.NewTransport(http.DefaultTransport)}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, k.url, nil)
	if err != nil {
		return err
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	var doc struct {
		Keys []struct{ Kid, Kty, N, E string } `json:"keys"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&doc); err != nil {
		return err
	}
	for _, jk := range doc.Keys {
		if jk.Kty != "RSA" {
			continue
		}
		n, err1 := base64.RawURLEncoding.DecodeString(jk.N)
		e, err2 := base64.RawURLEncoding.DecodeString(jk.E)
		if err1 != nil || err2 != nil {
			continue
		}
		k.keys[jk.Kid] = &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: int(new(big.Int).SetBytes(e).Int64())}
	}
	return nil
}

func authenticate(keys *jwks, rdb *redis.Client) func(http.Handler) http.Handler {
	parser := jwt.NewParser(jwt.WithValidMethods([]string{"RS256"}), jwt.WithIssuer("vijaybank-auth"),
		jwt.WithExpirationRequired(), jwt.WithLeeway(5*time.Second))
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			raw, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
			if !ok || raw == "" {
				writeError(w, r, 401, "UNAUTHENTICATED", "login required")
				return
			}
			claims := jwt.MapClaims{}
			_, err := parser.ParseWithClaims(raw, claims, func(t *jwt.Token) (any, error) {
				kid, _ := t.Header["kid"].(string)
				return keys.key(r.Context(), kid)
			})
			if err != nil {
				code := "INVALID_TOKEN"
				if errors.Is(err, jwt.ErrTokenExpired) {
					code = "TOKEN_EXPIRED"
				}
				writeError(w, r, 401, code, "session is not valid, please log in again")
				return
			}
			sub, _ := claims["sub"].(string)
			jti, _ := claims["jti"].(string)
			// Logged-out tokens stay on a deny-list until they would have expired.
			if n, err := rdb.Exists(r.Context(), "deny:"+jti).Result(); err != nil || n > 0 {
				if err != nil {
					slog.ErrorContext(r.Context(), "deny-list check failed", "requestId", reqID(r), "error", err)
				}
				writeError(w, r, 401, "INVALID_TOKEN", "session is not valid, please log in again")
				return
			}
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), customerIDKey, sub)))
		})
	}
}

// rateLimiter allows `rps` requests per second per client IP with a burst.
type rateLimiter struct {
	mu      sync.Mutex
	clients map[string]*rate.Limiter
	rps     rate.Limit
	burst   int
}

func newRateLimiter(rps float64, burst int) *rateLimiter {
	return &rateLimiter{clients: map[string]*rate.Limiter{}, rps: rate.Limit(rps), burst: burst}
}

func (l *rateLimiter) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip, _, _ := net.SplitHostPort(r.RemoteAddr)
		if fwd := r.Header.Get("X-Real-IP"); fwd != "" {
			ip = fwd
		}
		l.mu.Lock()
		lim, ok := l.clients[ip]
		if !ok {
			lim = rate.NewLimiter(l.rps, l.burst)
			l.clients[ip] = lim
		}
		l.mu.Unlock()
		if !lim.Allow() {
			w.Header().Set("Retry-After", "1")
			writeError(w, r, 429, "RATE_LIMITED", "too many requests, slow down")
			return
		}
		next.ServeHTTP(w, r)
	})
}
