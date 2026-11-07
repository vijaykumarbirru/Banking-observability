# VijayBank — Net Banking (learning project)

A fictional retail bank built as polyglot microservices, run locally with
Docker Compose, as a base for practising observability. All data is fake.

See [docs/DESIGN.md](docs/DESIGN.md) for the full design.

## Run it

```bash
docker compose up -d --build     # first build takes a few minutes
docker compose ps                # wait until services are "healthy"
docker compose logs seed         # "seed complete" = demo data is ready
```

| What | URL |
|---|---|
| Net banking UI | http://localhost:8080 |
| API gateway | http://localhost:8000 |
| RabbitMQ management | http://localhost:15672 (vijaybank / vijaybank_pw) |

**Log in:** customer ID `VB100001` … `VB100020`, password `Welcome@123`.
The OTP appears in the *Developer inbox* panel on the OTP page (simulated SMS).

## Services

| Service | Language | Role |
|---|---|---|
| web-frontend | React + TypeScript (nginx) | UI; proxies `/api` to the gateway |
| api-gateway | Go | Routing, JWT validation, logout deny-list, rate limiting, request IDs |
| auth-service | Java 21 / Spring Boot | Password + OTP login, lockout, JWT (RS256), refresh tokens |
| customer-service | Python / FastAPI | Customer profile |
| account-service | Java 21 / Spring Boot | Accounts; balances and recent transactions from the ledger |
| ledger-service | Go | Double-entry ledger, atomic postings, idempotency |
| notification-service | Node.js | Consumes RabbitMQ events, simulated SMS, developer inbox |
| transfer-service | .NET 8 | Beneficiaries, limits, transfers with OTP, fraud check, ledger posting |
| settlement-worker | .NET 8 | Simulated IMPS/NEFT/RTGS clearing, automatic reversals |
| fraud-service | Python / FastAPI | Rule-based risk score (allow / flag / block) |
| audit-service | Python | Append-only audit trail of every event (secrets redacted) |
| statement-service | Go | Transaction history, PDF and CSV statements |
| payment-service | Node.js | Bill payments (simulated billers) with OTP |
| card-service | Kotlin / Ktor | Debit and credit cards: instant block, OTP to unblock or raise limits |
| seed | Python | One-shot demo data through internal APIs |

Fixed deposits live in account-service.

Infrastructure: PostgreSQL 16 (one database per service), Redis 7, RabbitMQ 3.13, MongoDB 7.

## Handy test data

| What | How |
|---|---|
| Two accounts (own transfers) | VB100003, VB100006, VB100009 … (every 3rd customer) |
| Credit card | VB100001, VB100003, VB100005 … (odd customers) |
| Existing fixed deposit | VB100001, VB100004, VB100007 … |
| See a transfer reversed | Send IMPS/NEFT to the beneficiary "Rejected Payee (test)" |
| Bill with nothing due | Any consumer number ending in 0 |

## Useful commands

```bash
docker compose logs -f auth-service           # follow one service
docker compose restart <service>              # restart one service
docker compose down                           # stop, keep data
docker compose down -v                        # stop and delete all data (re-seeds on next up)
```

## Try the API with curl

```bash
# 1. password step -> loginToken
curl -s localhost:8000/api/auth/login -H 'Content-Type: application/json' \
  -d '{"customerId":"VB100001","password":"Welcome@123"}'

# 2. read the OTP from the simulated SMS inbox
curl -s 'localhost:8000/api/notifications/dev-inbox?customerId=VB100001'

# 3. OTP step -> accessToken
curl -s localhost:8000/api/auth/otp/verify -H 'Content-Type: application/json' \
  -d '{"loginToken":"<loginToken>","otp":"<otp>"}'

# 4. call an authenticated endpoint
curl -s localhost:8000/api/accounts -H 'Authorization: Bearer <accessToken>'
```
