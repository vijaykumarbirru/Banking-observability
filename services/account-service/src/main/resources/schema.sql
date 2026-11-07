CREATE TABLE IF NOT EXISTS accounts (
  account_no   VARCHAR(20) PRIMARY KEY,
  customer_id  VARCHAR(16) NOT NULL,
  type         VARCHAR(10) NOT NULL CHECK (type IN ('SAVINGS', 'CURRENT')),
  status       VARCHAR(10) NOT NULL DEFAULT 'ACTIVE',
  branch       VARCHAR(60) NOT NULL,
  ifsc         VARCHAR(11) NOT NULL,
  nickname     VARCHAR(40),
  opened_on    DATE NOT NULL DEFAULT CURRENT_DATE
);

CREATE INDEX IF NOT EXISTS accounts_customer ON accounts (customer_id);

CREATE TABLE IF NOT EXISTS fixed_deposits (
  id                     UUID PRIMARY KEY,
  fd_no                  VARCHAR(20) NOT NULL UNIQUE,
  customer_id            VARCHAR(16) NOT NULL,
  idempotency_key        VARCHAR(80) NOT NULL,
  funding_account        VARCHAR(20) NOT NULL,
  principal_paise        BIGINT NOT NULL CHECK (principal_paise > 0),
  rate_bps               INT NOT NULL,
  tenure_months          INT NOT NULL,
  start_date             DATE NOT NULL,
  maturity_date          DATE NOT NULL,
  maturity_amount_paise  BIGINT NOT NULL,
  status                 VARCHAR(10) NOT NULL DEFAULT 'ACTIVE',
  closed_on              DATE,
  payout_paise           BIGINT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (customer_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS fixed_deposits_customer ON fixed_deposits (customer_id);
