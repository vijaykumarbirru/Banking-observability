-- One database and one login per service. Services never read another
-- service's database. Lab-only passwords; override for anything shared.

CREATE USER auth_svc     WITH PASSWORD 'auth_pw';
CREATE USER customer_svc WITH PASSWORD 'customer_pw';
CREATE USER account_svc  WITH PASSWORD 'account_pw';
CREATE USER ledger_svc   WITH PASSWORD 'ledger_pw';
CREATE USER transfer_svc WITH PASSWORD 'transfer_pw';
CREATE USER payment_svc  WITH PASSWORD 'payment_pw';
CREATE USER card_svc     WITH PASSWORD 'card_pw';

CREATE DATABASE auth     OWNER auth_svc;
CREATE DATABASE customer OWNER customer_svc;
CREATE DATABASE account  OWNER account_svc;
CREATE DATABASE ledger   OWNER ledger_svc;
CREATE DATABASE transfer OWNER transfer_svc;
CREATE DATABASE payment  OWNER payment_svc;
CREATE DATABASE card     OWNER card_svc;
