CREATE TABLE IF NOT EXISTS credentials (
  customer_id      VARCHAR(16) PRIMARY KEY,
  password_hash    VARCHAR(100) NOT NULL,
  failed_attempts  INT NOT NULL DEFAULT 0,
  locked_until     TIMESTAMPTZ,
  last_login_at    TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
