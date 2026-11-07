package main

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
)

// System-owned ledger accounts. Unlike customer accounts they may go negative.
var internalAccounts = []string{
	"OPENING_BALANCE_EQUITY",
	"EXTERNAL_SETTLEMENT",
	"NEFT_CLEARING",
	"IMPS_CLEARING",
	"RTGS_CLEARING",
	"BILLPAY_SETTLEMENT",
	"FD_POOL",
	"INTEREST_EXPENSE",
}

const schema = `
CREATE TABLE IF NOT EXISTS ledger_accounts (
  account_no     TEXT PRIMARY KEY,
  owner_type     TEXT NOT NULL CHECK (owner_type IN ('CUSTOMER', 'INTERNAL')),
  currency       TEXT NOT NULL DEFAULT 'INR',
  balance_paise  BIGINT NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'ACTIVE',
  version        BIGINT NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS journals (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key  TEXT NOT NULL UNIQUE,
  type             TEXT NOT NULL,
  reference        TEXT,
  posted_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS entries (
  id                   BIGSERIAL PRIMARY KEY,
  journal_id           UUID NOT NULL REFERENCES journals(id),
  account_no           TEXT NOT NULL REFERENCES ledger_accounts(account_no),
  direction            TEXT NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
  amount_paise         BIGINT NOT NULL CHECK (amount_paise > 0),
  balance_after_paise  BIGINT NOT NULL,
  narration            TEXT,
  posted_at            TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS entries_account_posted ON entries (account_no, posted_at DESC, id DESC);
`

func migrate(ctx context.Context, db *pgxpool.Pool) error {
	if _, err := db.Exec(ctx, schema); err != nil {
		return err
	}
	for _, a := range internalAccounts {
		if _, err := db.Exec(ctx,
			`INSERT INTO ledger_accounts (account_no, owner_type) VALUES ($1, 'INTERNAL') ON CONFLICT DO NOTHING`, a); err != nil {
			return err
		}
	}
	return nil
}
