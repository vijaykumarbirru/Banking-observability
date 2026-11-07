// statement-service: transaction history with filters and paging, and
// downloadable PDF / CSV statements. Reads money data from ledger-service
// and checks ownership with account-service.
package main

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

var ist = time.FixedZone("IST", 5*3600+30*60)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)).With("service", "statement-service"))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	s := &server{
		ledger:   env("LEDGER_URL", "http://ledger-service:8084"),
		account:  env("ACCOUNT_URL", "http://account-service:8083"),
		customer: env("CUSTOMER_URL", "http://customer-service:8082"),
		http:     &http.Client{Timeout: 10 * time.Second},
	}
	r := chi.NewRouter()
	r.Use(requestID, accessLog, middleware.Recoverer)
	r.Get("/health/live", func(w http.ResponseWriter, _ *http.Request) { writeJSON(w, 200, map[string]string{"status": "UP"}) })
	r.Get("/health/ready", func(w http.ResponseWriter, _ *http.Request) { writeJSON(w, 200, map[string]string{"status": "UP"}) })
	r.Get("/accounts/{accountNo}/transactions", s.transactions)
	r.Get("/accounts/{accountNo}/statement.pdf", s.statement("pdf"))
	r.Get("/accounts/{accountNo}/statement.csv", s.statement("csv"))

	srv := &http.Server{Addr: ":" + env("PORT", "8089"), Handler: r, ReadHeaderTimeout: 5 * time.Second}
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

type server struct {
	ledger, account, customer string
	http                      *http.Client
}

type entry struct {
	ID                int64     `json:"id"`
	Type              string    `json:"type"`
	Reference         string    `json:"reference"`
	Direction         string    `json:"direction"`
	AmountPaise       int64     `json:"amountPaise"`
	BalanceAfterPaise int64     `json:"balanceAfterPaise"`
	Narration         string    `json:"narration"`
	PostedAt          time.Time `json:"postedAt"`
}

type account struct {
	AccountNo  string `json:"accountNo"`
	CustomerID string `json:"customerId"`
	Type       string `json:"type"`
	Branch     string `json:"branch"`
	Ifsc       string `json:"ifsc"`
}

type customer struct {
	FullName string `json:"fullName"`
	Address  string `json:"address"`
	City     string `json:"city"`
}

type summary struct {
	OpeningBalancePaise int64 `json:"openingBalancePaise"`
	ClosingBalancePaise int64 `json:"closingBalancePaise"`
	TotalCreditsPaise   int64 `json:"totalCreditsPaise"`
	TotalDebitsPaise    int64 `json:"totalDebitsPaise"`
	Count               int   `json:"count"`
}

type period struct{ from, to time.Time } // IST calendar days; to is inclusive

func (p period) fromUTC() string { return p.from.UTC().Format(time.RFC3339) }
func (p period) toUTC() string   { return p.to.AddDate(0, 0, 1).UTC().Format(time.RFC3339) }

var errNotFound = errors.New("not found")

// parsePeriod reads ?from=&to= (YYYY-MM-DD, IST). Defaults to the last 30 days.
func parsePeriod(r *http.Request) (period, string) {
	today := time.Now().In(ist)
	today = time.Date(today.Year(), today.Month(), today.Day(), 0, 0, 0, 0, ist)
	p := period{from: today.AddDate(0, 0, -29), to: today}
	for name, dst := range map[string]*time.Time{"from": &p.from, "to": &p.to} {
		if v := r.URL.Query().Get(name); v != "" {
			t, err := time.ParseInLocation("2006-01-02", v, ist)
			if err != nil {
				return p, name + " must be a date like 2026-11-07"
			}
			*dst = t
		}
	}
	switch {
	case p.to.Before(p.from):
		return p, "from must be on or before to"
	case p.to.Sub(p.from) > 366*24*time.Hour:
		return p, "a statement can cover at most one year"
	case p.to.After(today):
		p.to = today
	}
	return p, ""
}

func (s *server) get(r *http.Request, url string, out any) (http.Header, error) {
	req, _ := http.NewRequestWithContext(r.Context(), http.MethodGet, url, nil)
	req.Header.Set("X-Request-Id", reqID(r))
	res, err := s.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotFound {
		return nil, errNotFound
	}
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s returned %d", url, res.StatusCode)
	}
	return res.Header, json.NewDecoder(res.Body).Decode(out)
}

// owned returns the account only if it belongs to the calling customer.
func (s *server) owned(w http.ResponseWriter, r *http.Request) (*account, bool) {
	cid := r.Header.Get("X-Customer-Id")
	if cid == "" {
		writeError(w, r, 401, "UNAUTHENTICATED", "Login required.")
		return nil, false
	}
	var a account
	_, err := s.get(r, s.account+"/internal/accounts/"+chi.URLParam(r, "accountNo"), &a)
	if errors.Is(err, errNotFound) || (err == nil && a.CustomerID != cid) {
		writeError(w, r, 404, "ACCOUNT_NOT_FOUND", "Account not found.")
		return nil, false
	}
	if err != nil {
		unavailable(w, r, err)
		return nil, false
	}
	return &a, true
}

func unavailable(w http.ResponseWriter, r *http.Request, err error) {
	logErr(r, "dependency failed", err)
	writeError(w, r, 503, "DEPENDENCY_UNAVAILABLE", "Statements are temporarily unavailable. Please try again shortly.")
}

func (s *server) transactions(w http.ResponseWriter, r *http.Request) {
	a, ok := s.owned(w, r)
	if !ok {
		return
	}
	p, msg := parsePeriod(r)
	if msg != "" {
		writeError(w, r, 400, "INVALID_REQUEST", msg)
		return
	}
	direction := r.URL.Query().Get("type")
	if direction != "" && direction != "CREDIT" && direction != "DEBIT" {
		writeError(w, r, 400, "INVALID_REQUEST", "type must be CREDIT or DEBIT")
		return
	}
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	size, _ := strconv.Atoi(r.URL.Query().Get("size"))
	page, size = max(page, 1), min(max(size, 1), 100)
	if r.URL.Query().Get("size") == "" {
		size = 20
	}

	var items []entry
	hdr, err := s.get(r, fmt.Sprintf("%s/internal/accounts/%s/entries?from=%s&to=%s&direction=%s&limit=%d&offset=%d",
		s.ledger, a.AccountNo, p.fromUTC(), p.toUTC(), direction, size, (page-1)*size), &items)
	if err != nil {
		unavailable(w, r, err)
		return
	}
	total, _ := strconv.Atoi(hdr.Get("X-Total-Count"))
	var sum summary
	if _, err := s.get(r, fmt.Sprintf("%s/internal/accounts/%s/summary?from=%s&to=%s",
		s.ledger, a.AccountNo, p.fromUTC(), p.toUTC()), &sum); err != nil {
		unavailable(w, r, err)
		return
	}
	writeJSON(w, 200, map[string]any{
		"accountNo": a.AccountNo, "from": p.from.Format("2006-01-02"), "to": p.to.Format("2006-01-02"),
		"page": page, "size": size, "total": total, "summary": sum, "items": items,
	})
}

const maxStatementEntries = 5000

func (s *server) statement(format string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		a, ok := s.owned(w, r)
		if !ok {
			return
		}
		p, msg := parsePeriod(r)
		if msg != "" {
			writeError(w, r, 400, "INVALID_REQUEST", msg)
			return
		}
		var items []entry
		hdr, err := s.get(r, fmt.Sprintf("%s/internal/accounts/%s/entries?from=%s&to=%s&limit=%d",
			s.ledger, a.AccountNo, p.fromUTC(), p.toUTC(), maxStatementEntries), &items)
		if err != nil {
			unavailable(w, r, err)
			return
		}
		if total, _ := strconv.Atoi(hdr.Get("X-Total-Count")); total > maxStatementEntries {
			writeError(w, r, 422, "STATEMENT_TOO_LARGE", "Too many transactions for one statement. Choose a shorter period.")
			return
		}
		// Statements read oldest first.
		for i, j := 0, len(items)-1; i < j; i, j = i+1, j-1 {
			items[i], items[j] = items[j], items[i]
		}
		var sum summary
		if _, err := s.get(r, fmt.Sprintf("%s/internal/accounts/%s/summary?from=%s&to=%s",
			s.ledger, a.AccountNo, p.fromUTC(), p.toUTC()), &sum); err != nil {
			unavailable(w, r, err)
			return
		}

		name := fmt.Sprintf("VijayBank_Statement_%s_%s_%s.%s", maskAccount(a.AccountNo), p.from.Format("20060102"), p.to.Format("20060102"), format)
		w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
		w.Header().Set("Cache-Control", "no-store")
		slog.Info("statement generated", "requestId", reqID(r), "format", format, "entries", len(items))

		if format == "csv" {
			w.Header().Set("Content-Type", "text/csv; charset=utf-8")
			writeCSV(w, a, p, sum, items)
			return
		}
		var c customer
		if _, err := s.get(r, s.customer+"/internal/customers/"+a.CustomerID, &c); err != nil {
			unavailable(w, r, err)
			return
		}
		w.Header().Set("Content-Type", "application/pdf")
		if err := writePDF(w, a, c, p, sum, items); err != nil {
			logErr(r, "pdf generation failed", err)
		}
	}
}

func writeCSV(w http.ResponseWriter, a *account, p period, sum summary, items []entry) {
	cw := csv.NewWriter(w)
	_ = cw.Write([]string{"VijayBank account statement", a.AccountNo, p.from.Format("02-01-2006") + " to " + p.to.Format("02-01-2006")})
	_ = cw.Write([]string{"Opening balance", rupees(sum.OpeningBalancePaise)})
	_ = cw.Write([]string{})
	_ = cw.Write([]string{"Date", "Description", "Reference", "Debit", "Credit", "Balance"})
	for _, e := range items {
		debit, credit := "", ""
		if e.Direction == "DEBIT" {
			debit = rupees(e.AmountPaise)
		} else {
			credit = rupees(e.AmountPaise)
		}
		_ = cw.Write([]string{e.PostedAt.In(ist).Format("02-01-2006 15:04"), e.Narration, e.Reference, debit, credit, rupees(e.BalanceAfterPaise)})
	}
	_ = cw.Write([]string{})
	_ = cw.Write([]string{"Closing balance", rupees(sum.ClosingBalancePaise)})
	cw.Flush()
}

func maskAccount(no string) string {
	if len(no) <= 4 {
		return no
	}
	return "XX" + no[len(no)-4:]
}

// rupees formats paise in the Indian digit grouping: 1234567.89 -> 12,34,567.89
func rupees(paise int64) string {
	neg := paise < 0
	if neg {
		paise = -paise
	}
	whole, frac := strconv.FormatInt(paise/100, 10), paise%100
	var out []byte
	for i, n := len(whole)-1, 0; i >= 0; i, n = i-1, n+1 {
		if n == 3 || (n > 3 && (n-3)%2 == 0) {
			out = append([]byte{','}, out...)
		}
		out = append([]byte{whole[i]}, out...)
	}
	s := fmt.Sprintf("%s.%02d", out, frac)
	if neg {
		s = "-" + s
	}
	return s
}
