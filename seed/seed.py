"""One-shot seed job: creates 20 fictional customers with credentials,
accounts, opening balances and ~6 months of history.

It only uses the services' internal APIs (never their databases directly),
and every call is idempotent, so running it again changes nothing.
"""

import os
import random
import sys
import time
from datetime import date, datetime, time as dtime, timedelta, timezone

import httpx

AUTH = os.getenv("AUTH_URL", "http://auth-service:8081")
CUSTOMER = os.getenv("CUSTOMER_URL", "http://customer-service:8082")
ACCOUNT = os.getenv("ACCOUNT_URL", "http://account-service:8083")
LEDGER = os.getenv("LEDGER_URL", "http://ledger-service:8084")
TRANSFER = os.getenv("TRANSFER_URL", "http://transfer-service:8085")
IST = timezone(timedelta(hours=5, minutes=30))
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
    day = start.astimezone(IST).date() + timedelta(days=1)
    employer = rng.choice(EMPLOYERS)

    def at(h, m):  # a local (IST) time on `day`, stored in UTC
        return datetime.combine(day, dtime(h, m), IST).astimezone(timezone.utc)

    while at(23, 59) < now - timedelta(hours=1):
        if savings and day.day == 1:
            events.append(("SALARY", at(9, 30)))
        for _ in range(rng.choice([0, 0, 1, 1, 2])):
            events.append(("SPEND", at(rng.randint(8, 21), rng.randint(0, 59))))
        day += timedelta(days=1)

    for i, (kind, posted) in enumerate(sorted(events, key=lambda e: e[1])):
        key = f"seed:{account_no}:h{i:04d}"
        if kind == "SALARY":
            amount = rng.randint(45_000, 180_000) * 100
            journal(client, key, "SALARY_CREDIT", posted, "EXTERNAL_SETTLEMENT", account_no, amount,
                    f"SALARY CREDIT - {employer}")
            balance += amount
            continue
        channel, merchants, (lo, hi) = rng.choice(SPEND)
        amount = rng.randint(lo, hi) * 100
        if amount > balance:
            continue
        narration = f"{channel}/{rng.choice(merchants)}" if merchants else f"{channel}/{city.upper()}"
        journal(client, key, "CARD_UPI_DEBIT", posted, account_no, "EXTERNAL_SETTLEMENT", amount, narration)
        balance -= amount


def seed_beneficiaries(client, n, customer_id):
    """Ready-to-use beneficiaries (past the cooling period) for every customer."""
    peer = n % 20 + 1
    payees = [
        (f"{FIRST[peer - 1]} {LAST[peer - 1]}", f"1001{100000 + peer:08d}", f"VIJB0000{100 + peer % len(CITIES)}", "Friend"),
        ("Sneha Kulkarni", f"50200{n:07d}", "BCBK0000123", "Sister"),
        ("Prakash Rao", f"3100{n:06d}88", "SNBK0000456", "Landlord"),
        # The simulated destination bank always rejects accounts ending in 0000: use it to see a reversal.
        ("Rejected Payee (test)", f"77770{n:03d}0000", "DCOB0000789", "Test reversal"),
    ]
    for name, account_no, ifsc, nickname in payees:
        call(client, "POST", f"{TRANSFER}/internal/beneficiaries", {
            "customerId": customer_id, "name": name, "accountNo": account_no, "ifsc": ifsc, "nickname": nickname,
            "activeSince": (datetime.now(timezone.utc) - timedelta(days=30)).isoformat(),
        })


def main() -> None:
    with httpx.Client(timeout=15) as client:
        for name, url in [("ledger-service", LEDGER), ("auth-service", AUTH),
                          ("customer-service", CUSTOMER), ("account-service", ACCOUNT),
                          ("transfer-service", TRANSFER)]:
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
            seed_beneficiaries(client, n, customer_id)
            print(f"seeded {customer_id} ({first} {last}) with {len(accounts)} account(s)", flush=True)

    print("seed complete: log in with VB100001..VB100020 / " + PASSWORD, flush=True)


if __name__ == "__main__":
    main()
