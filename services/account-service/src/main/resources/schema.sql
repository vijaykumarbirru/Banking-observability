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
