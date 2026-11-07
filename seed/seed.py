"""One-shot seed job: creates 20 fictional customers with credentials,
accounts, opening balances and ~6 months of history.

It only uses the services' internal APIs (never their databases directly),
and every call is idempotent, so running it again changes nothing.
"""

import os
import random
import sys
import time
from datetime import date, datetime, timedelta, timezone

import httpx

AUTH = os.getenv("AUTH_URL", "http://auth-service:8081")
CUSTOMER = os.getenv("CUSTOMER_URL", "http://customer-service:8082")
ACCOUNT = os.getenv("ACCOUNT_URL", "http://account-service:8083")
LEDGER = os.getenv("LEDGER_URL", "http://ledger-service:8084")
PASSWORD = os.getenv("SEED_PASSWORD", "Welcome@123")

FIRST = ["Aarav", "Ananya", "Rohan", "Diya", "Kabir", "Meera", "Arjun", "Isha", "Vihaan", "Saanvi",
         "Aditya", "Kavya", "Reyansh", "Nisha", "Krish", "Pooja", "Ishaan", "Tara", "Dev", "Riya"]
LAST = ["Sharma", "Iyer", "Reddy", "Patel", "Nair", "Gupta", "Rao", "Menon", "Joshi", "Kulkarni",
        "Verma", "Pillai", "Desai", "Bose", "Shetty", "Mehta", "Chopra", "Das", "Kapoor", "Naidu"]
CITIES = [("Hyderabad", "Banjara Hills"), ("Bengaluru", "Koramangala"), ("Mumbai", "Andheri East"),
          ("Chennai", "T. Nagar"), ("Pune", "Kothrud"), ("Delhi", "Connaught Place")]
EMPLOYERS = ["ACME SOFTWARE PVT LTD", "NORTHWIND TRADERS", "CONTOSO LABS", "GLOBEX INDIA", "INITECH SERVICES"]
SPEND = [("UPI", ["SWIGGY", "ZOMATO", "BIGBASKET", "UBER", "OLA", "PHONEPE RECHARGE", "LOCAL KIRANA"], (150, 2_500)),
         ("POS", ["DMART", "RELIANCE TRENDS", "CROMA", "SHOPPERS STOP", "MORE SUPERMARKET"], (500, 9_000)),
         ("ATM WDL", None, (2_000, 10_000)),
         ("BILLPAY", ["ELECTRICITY", "BROADBAND", "MOBILE POSTPAID", "GAS"], (400, 3_500))]


def wait_for(client: httpx.Client, name: str, url: str) -> None:
    for attempt in range(90):
        try:
            if client.get(url + "/health/ready").status_code == 200:
                print(f"{name} ready", flush=True)
                return
        except httpx.HTTPError:
            pass
        time.sleep(2)
    sys.exit(f"{name} did not become ready")


def call(client: httpx.Client, method: str, url: str, body: dict) -> dict:
    r = client.request(method, url, json=body)
    if r.status_code >= 400:
        sys.exit(f"{method} {url} failed: {r.status_code} {r.text}")
    return r.json()


def journal(client, key, jtype, posted_at, debit, credit, amount_paise, narration):
    return call(client, "POST", f"{LEDGER}/internal/journals", {
        "idempotencyKey": key,
        "type": jtype,
        "reference": key.split(":")[-1].upper(),
        "postedAt": posted_at.isoformat(),
        "entries": [
            {"accountNo": debit, "direction": "DEBIT", "amountPaise": amount_paise, "narration": narration},
            {"accountNo": credit, "direction": "CREDIT", "amountPaise": amount_paise, "narration": narration},
        ],
    })


def seed_history(client, rng, account_no, opening_paise, start, savings, city):
    """Posts a salary every month plus everyday spending, never overdrawing."""
    balance = opening_paise
    now = datetime.now(timezone.utc)
    events = []
    day = start + timedelta(days=1)
    employer = rng.choice(EMPLOYERS)
    while day < now - timedelta(hours=2):
        if savings and day.day == 1:
            events.append(("SALARY", day.replace(hour=9, minute=30)))
        for _ in range(rng.choice([0, 0, 1, 1, 2])):
            events.append(("SPEND", day.replace(hour=rng.randint(8, 22), minute=rng.randint(0, 59))))
        day += timedelta(days=1)

    for i, (kind, at) in enumerate(sorted(events, key=lambda e: e[1])):
        key = f"seed:{account_no}:h{i:04d}"
        if kind == "SALARY":
            amount = rng.randint(45_000, 180_000) * 100
            journal(client, key, "SALARY_CREDIT", at, "EXTERNAL_SETTLEMENT", account_no, amount,
                    f"SALARY CREDIT - {employer}")
            balance += amount
            continue
        channel, merchants, (lo, hi) = rng.choice(SPEND)
        amount = rng.randint(lo, hi) * 100
        if amount > balance:
            continue
        narration = f"{channel}/{rng.choice(merchants)}" if merchants else f"{channel}/{city.upper()}"
        journal(client, key, "CARD_UPI_DEBIT", at, account_no, "EXTERNAL_SETTLEMENT", amount, narration)
        balance -= amount


def main() -> None:
    with httpx.Client(timeout=15) as client:
        for name, url in [("ledger-service", LEDGER), ("auth-service", AUTH),
                          ("customer-service", CUSTOMER), ("account-service", ACCOUNT)]:
            wait_for(client, name, url)

        rng = random.Random(42)  # deterministic: same data on every machine
        start = datetime.now(timezone.utc).replace(hour=10, minute=0, second=0, microsecond=0) - timedelta(days=180)

        for n in range(1, 21):
            customer_id = f"VB{100000 + n}"
            first, last = FIRST[n - 1], LAST[n - 1]
            city, area = CITIES[n % len(CITIES)]
            call(client, "POST", f"{CUSTOMER}/internal/customers", {
                "customerId": customer_id,
                "fullName": f"{first} {last}",
                "email": f"{first.lower()}.{last.lower()}@example.com",
                "mobile": f"90000{n:05d}",
                "dob": (date(1975, 1, 1) + timedelta(days=rng.randint(0, 9000))).isoformat(),
                "address": f"{rng.randint(1, 400)}, {area}",
                "city": city,
            })
            call(client, "POST", f"{AUTH}/internal/credentials", {"customerId": customer_id, "password": PASSWORD})

            accounts = [("SAVINGS", f"1001{100000 + n:08d}")]
            if n % 3 == 0:
                accounts.append(("CURRENT", f"2001{100000 + n:08d}"))
            for acct_type, account_no in accounts:
                branch_no = 100 + (n % len(CITIES))
                call(client, "POST", f"{ACCOUNT}/internal/accounts", {
                    "accountNo": account_no, "customerId": customer_id, "type": acct_type,
                    "branch": f"{city} - {area}", "ifsc": f"VIJB0000{branch_no}",
                    "openedOn": start.date().isoformat(),
                })
                call(client, "POST", f"{LEDGER}/internal/ledger-accounts",
                     {"accountNo": account_no, "ownerType": "CUSTOMER"})
                opening = rng.randint(10_000, 2_500_000) * 100
                journal(client, f"seed:{account_no}:opening", "OPENING_BALANCE", start,
                        "OPENING_BALANCE_EQUITY", account_no, opening, "OPENING BALANCE")
                seed_history(client, rng, account_no, opening, start, acct_type == "SAVINGS", city)
            print(f"seeded {customer_id} ({first} {last}) with {len(accounts)} account(s)", flush=True)

    print("seed complete: log in with VB100001..VB100020 / " + PASSWORD, flush=True)


if __name__ == "__main__":
    main()
