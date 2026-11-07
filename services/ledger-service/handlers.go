package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type handlers struct{ db *pgxpool.Pool }

type entryReq struct {
	AccountNo   string `json:"accountNo"`
	Direction   string `json:"direction"`
	AmountPaise int64  `json:"amountPaise"`
	Narration   string `json:"narration"`
}

type journalReq struct {
	IdempotencyKey string     `json:"idempotencyKey"`
	Type           string     `json:"type"`
	Reference      string     `json:"reference"`
	PostedAt       *time.Time `json:"postedAt"` // seed/back-dating only
	Entries        []entryReq `json:"entries"`
}

type entryResp struct {
	ID                int64     `json:"id"`
	JournalID         string    `json:"journalId"`
	Type              string    `json:"type"`
	Reference         string    `json:"reference"`
	AccountNo         string    `json:"accountNo"`
	Direction         string    `json:"direction"`
	AmountPaise       int64     `json:"amountPaise"`
	BalanceAfterPaise int64     `json:"balanceAfterPaise"`
	Narration         string    `json:"narration"`
	PostedAt          time.Time `json:"postedAt"`
}

type journalResp struct {
	JournalID string      `json:"journalId"`
	Replayed  bool        `json:"replayed"`
	Entries   []entryResp `json:"entries"`
}

func (h *handlers) ready(w http.ResponseWriter, r *http.Request) {
	if err := h.db.Ping(r.Context()); err != nil {
		writeJSON(w, 503, map[string]string{"status": "DOWN"})
		return
	}
	writeJSON(w, 200, map[string]string{"status": "UP"})
}

func (h *handlers) createAccount(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AccountNo string `json:"accountNo"`
		OwnerType string `json:"ownerType"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.AccountNo == "" {
		writeError(w, r, 400, "INVALID_REQUEST", "accountNo is required")
		return
	}
	if req.OwnerType == "" {
		req.OwnerType = "CUSTOMER"
	}
	_, err := h.db.Exec(r.Context(),
		`INSERT INTO ledger_accounts (account_no, owner_type) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
		req.AccountNo, req.OwnerType)
	if err != nil {
		writeError(w, r, 500, "INTERNAL_ERROR", "could not create ledger account")
		logErr(r, "create account failed", err)
		return
	}
	writeJSON(w, 201, map[string]string{"accountNo": req.AccountNo})
}

func validate(req *journalReq) string {
	if req.IdempotencyKey == "" || req.Type == "" {
		return "idempotencyKey and type are required"
	}
	if len(req.Entries) < 2 {
		return "a journal needs at least two entries"
	}
	var debit, credit int64
	for _, e := range req.Entries {
		if e.AccountNo == "" || e.AmountPaise <= 0 {
			return "every entry needs an accountNo and a positive amountPaise"
		}
		switch e.Direction {
		case "DEBIT":
			debit += e.AmountPaise
		case "CREDIT":
			credit += e.AmountPaise
		default:
			return "direction must be DEBIT or CREDIT"
		}
	}
	if debit != credit {
		return "debits and credits must balance"
	}
	return ""
}

var errInsufficientFunds = errors.New("insufficient funds")
var errAccountNotFound = errors.New("account not found")
var errAccountInactive = errors.New("account not active")

// postJournal applies a balanced set of entries atomically. A repeated
// idempotency key returns the original result instead of posting twice.
func (h *handlers) postJournal(w http.ResponseWriter, r *http.Request) {
	var req journalReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, r, 400, "INVALID_REQUEST", "malformed JSON")
		return
	}
	if msg := validate(&req); msg != "" {
		writeError(w, r, 400, "INVALID_JOURNAL", msg)
		return
	}

	if existing, err := h.findJournal(r.Context(), req.IdempotencyKey); err == nil {
		existing.Replayed = true
		writeJSON(w, 200, existing)
		return
	}

	resp, err := h.apply(r.Context(), &req)
	var pgErr *pgconn.PgError
	switch {
	case err == nil:
		writeJSON(w, 201, resp)
	case errors.As(err, &pgErr) && pgErr.Code == "23505":
		// Lost a race with a concurrent request carrying the same key.
		existing, ferr := h.findJournal(r.Context(), req.IdempotencyKey)
		if ferr != nil {
			writeError(w, r, 500, "INTERNAL_ERROR", "could not read journal")
			return
		}
		existing.Replayed = true
		writeJSON(w, 200, existing)
	case errors.Is(err, errInsufficientFunds):
		writeError(w, r, 422, "INSUFFICIENT_FUNDS", "insufficient balance")
	case errors.Is(err, errAccountNotFound):
		writeError(w, r, 404, "ACCOUNT_NOT_FOUND", err.Error())
	case errors.Is(err, errAccountInactive):
		writeError(w, r, 422, "ACCOUNT_INACTIVE", err.Error())
	default:
		logErr(r, "posting failed", err)
		writeError(w, r, 500, "INTERNAL_ERROR", "posting failed")
	}
}

func (h *handlers) apply(ctx context.Context, req *journalReq) (*journalResp, error) {
	tx, err := h.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	// Lock every affected balance row, always in account-number order so two
	// concurrent journals can never deadlock on each other.
	accts := map[string]bool{}
	for _, e := range req.Entries {
		accts[e.AccountNo] = true
	}
	ordered := make([]string, 0, len(accts))
	for a := range accts {
		ordered = append(ordered, a)
	}
	sort.Strings(ordered)

	type acct struct {
		owner, status string
		balance       int64
	}
	locked := map[string]*acct{}
	rows, err := tx.Query(ctx,
		`SELECT account_no, owner_type, status, balance_paise FROM ledger_accounts
		 WHERE account_no = ANY($1) ORDER BY account_no FOR UPDATE`, ordered)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var no string
		a := &acct{}
		if err := rows.Scan(&no, &a.owner, &a.status, &a.balance); err != nil {
			rows.Close()
			return nil, err
		}
		locked[no] = a
	}
	rows.Close()
	for _, no := range ordered {
		a, ok := locked[no]
		if !ok {
			return nil, errors.Join(errAccountNotFound, errors.New(no))
		}
		if a.status != "ACTIVE" {
			return nil, errAccountInactive
		}
	}

	postedAt := time.Now().UTC()
	if req.PostedAt != nil {
		postedAt = req.PostedAt.UTC()
	}
	var journalID string
	if err := tx.QueryRow(ctx,
		`INSERT INTO journals (idempotency_key, type, reference, posted_at) VALUES ($1, $2, $3, $4) RETURNING id`,
		req.IdempotencyKey, req.Type, req.Reference, postedAt).Scan(&journalID); err != nil {
		return nil, err
	}

	resp := &journalResp{JournalID: journalID}
	for _, e := range req.Entries {
		a := locked[e.AccountNo]
		if e.Direction == "CREDIT" {
			a.balance += e.AmountPaise
		} else {
			a.balance -= e.AmountPaise
		}
		var id int64
		if err := tx.QueryRow(ctx,
			`INSERT INTO entries (journal_id, account_no, direction, amount_paise, balance_after_paise, narration, posted_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
			journalID, e.AccountNo, e.Direction, e.AmountPaise, a.balance, e.Narration, postedAt).Scan(&id); err != nil {
			return nil, err
		}
		resp.Entries = append(resp.Entries, entryResp{
			ID: id, JournalID: journalID, Type: req.Type, Reference: req.Reference, AccountNo: e.AccountNo,
			Direction: e.Direction, AmountPaise: e.AmountPaise, BalanceAfterPaise: a.balance,
			Narration: e.Narration, PostedAt: postedAt,
		})
	}
	for _, no := range ordered {
		if a := locked[no]; a.owner == "CUSTOMER" && a.balance < 0 {
			return nil, errInsufficientFunds
		}
	}
	for _, no := range ordered {
		if _, err := tx.Exec(ctx,
			`UPDATE ledger_accounts SET balance_paise = $2, version = version + 1, updated_at = now() WHERE account_no = $1`,
			no, locked[no].balance); err != nil {
			return nil, err
		}
	}
	return resp, tx.Commit(ctx)
}

func (h *handlers) findJournal(ctx context.Context, key string) (*journalResp, error) {
	rows, err := h.db.Query(ctx,
		`SELECT e.id, j.id, j.type, COALESCE(j.reference, ''), e.account_no, e.direction, e.amount_paise,
		        e.balance_after_paise, COALESCE(e.narration, ''), e.posted_at
		 FROM journals j JOIN entries e ON e.journal_id = j.id
		 WHERE j.idempotency_key = $1 ORDER BY e.id`, key)
	if err != nil {
		return nil, err
	}
	entries, err := scanEntries(rows)
	if err != nil {
		return nil, err
	}
	if len(entries) == 0 {
		return nil, pgx.ErrNoRows
	}
	return &journalResp{JournalID: entries[0].JournalID, Entries: entries}, nil
}

func scanEntries(rows pgx.Rows) ([]entryResp, error) {
	defer rows.Close()
	out := []entryResp{}
	for rows.Next() {
		var e entryResp
		if err := rows.Scan(&e.ID, &e.JournalID, &e.Type, &e.Reference, &e.AccountNo, &e.Direction,
			&e.AmountPaise, &e.BalanceAfterPaise, &e.Narration, &e.PostedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func (h *handlers) balances(w http.ResponseWriter, r *http.Request) {
	list := strings.Split(r.URL.Query().Get("accounts"), ",")
	rows, err := h.db.Query(r.Context(),
		`SELECT account_no, balance_paise, currency FROM ledger_accounts WHERE account_no = ANY($1)`, list)
	if err != nil {
		logErr(r, "balances failed", err)
		writeError(w, r, 500, "INTERNAL_ERROR", "could not read balances")
		return
	}
	defer rows.Close()
	type bal struct {
		AccountNo    string `json:"accountNo"`
		BalancePaise int64  `json:"balancePaise"`
		Currency     string `json:"currency"`
	}
	out := []bal{}
	for rows.Next() {
		var b bal
		if err := rows.Scan(&b.AccountNo, &b.BalancePaise, &b.Currency); err != nil {
			writeError(w, r, 500, "INTERNAL_ERROR", "could not read balances")
			return
		}
		out = append(out, b)
	}
	writeJSON(w, 200, out)
}

func (h *handlers) entries(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 200 {
		limit = 20
	}
	rows, err := h.db.Query(r.Context(),
		`SELECT e.id, j.id, j.type, COALESCE(j.reference, ''), e.account_no, e.direction, e.amount_paise,
		        e.balance_after_paise, COALESCE(e.narration, ''), e.posted_at
		 FROM entries e JOIN journals j ON j.id = e.journal_id
		 WHERE e.account_no = $1 ORDER BY e.posted_at DESC, e.id DESC LIMIT $2`,
		chi.URLParam(r, "accountNo"), limit)
	if err != nil {
		logErr(r, "entries failed", err)
		writeError(w, r, 500, "INTERNAL_ERROR", "could not read entries")
		return
	}
	out, err := scanEntries(rows)
	if err != nil {
		writeError(w, r, 500, "INTERNAL_ERROR", "could not read entries")
		return
	}
	writeJSON(w, 200, out)
}
