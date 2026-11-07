"""customer-service: customer profile and KYC status."""

import logging
import os
import time
import uuid
from contextlib import asynccontextmanager
from contextvars import ContextVar
from datetime import date

from fastapi import FastAPI, Header, Request
from fastapi.responses import JSONResponse
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool
from pydantic import BaseModel, Field
from pythonjsonlogger import jsonlogger

request_id: ContextVar[str] = ContextVar("request_id", default="")
customer_ctx: ContextVar[str] = ContextVar("customer_id", default="")


class ContextFilter(logging.Filter):
    def filter(self, record):
        record.service = "customer-service"
        record.requestId = request_id.get()
        if customer_ctx.get():
            record.customerId = customer_ctx.get()
        return True


handler = logging.StreamHandler()
handler.setFormatter(jsonlogger.JsonFormatter(
    "%(asctime)s %(levelname)s %(name)s %(message)s",
    rename_fields={"asctime": "timestamp", "levelname": "level"}))
handler.addFilter(ContextFilter())
logging.basicConfig(level=logging.INFO, handlers=[handler], force=True)
logging.getLogger("uvicorn.access").disabled = True
log = logging.getLogger("customer")

SCHEMA = """
CREATE TABLE IF NOT EXISTS customers (
  customer_id  VARCHAR(16) PRIMARY KEY,
  full_name    VARCHAR(100) NOT NULL,
  email        VARCHAR(120) NOT NULL,
  mobile       VARCHAR(15) NOT NULL,
  dob          DATE NOT NULL,
  address      VARCHAR(200) NOT NULL,
  city         VARCHAR(60) NOT NULL,
  kyc_status   VARCHAR(12) NOT NULL DEFAULT 'VERIFIED',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
"""

pool = ConnectionPool(
    os.getenv("DATABASE_URL", "postgresql://customer_svc:customer_pw@postgres:5432/customer"),
    min_size=1, max_size=10, open=False, kwargs={"row_factory": dict_row})


@asynccontextmanager
async def lifespan(_app):
    pool.open(wait=True, timeout=60)
    with pool.connection() as conn:
        conn.execute(SCHEMA)
    log.info("customer-service ready")
    yield
    pool.close()


app = FastAPI(title="customer-service", lifespan=lifespan)


def error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status,
                        content={"error": {"code": code, "message": message, "requestId": request_id.get()}})


@app.middleware("http")
async def request_context(request: Request, call_next):
    rid = request.headers.get("x-request-id") or uuid.uuid4().hex
    request_id.set(rid)
    customer_ctx.set(request.headers.get("x-customer-id", ""))
    start = time.perf_counter()
    response = await call_next(request)
    response.headers["X-Request-Id"] = rid
    if not request.url.path.startswith("/health"):
        log.info("request", extra={"method": request.method, "path": request.url.path,
                                   "status": response.status_code,
                                   "durationMs": round((time.perf_counter() - start) * 1000)})
    return response


def mask_mobile(m: str) -> str:
    return "XXXXXX" + m[-4:]


def mask_email(e: str) -> str:
    user, _, domain = e.partition("@")
    return f"{user[:2]}{'*' * max(len(user) - 2, 1)}@{domain}"


@app.get("/health/live")
def live():
    return {"status": "UP"}


@app.get("/health/ready")
def ready():
    try:
        with pool.connection() as conn:
            conn.execute("SELECT 1")
        return {"status": "UP"}
    except Exception:  # noqa: BLE001 — any DB failure means not ready
        return JSONResponse(status_code=503, content={"status": "DOWN"})


@app.get("/customers/me")
def me(x_customer_id: str | None = Header(default=None)):
    if not x_customer_id:
        return error(401, "UNAUTHENTICATED", "Login required.")
    with pool.connection() as conn:
        row = conn.execute("SELECT * FROM customers WHERE customer_id = %s", (x_customer_id,)).fetchone()
    if row is None:
        return error(404, "CUSTOMER_NOT_FOUND", "Customer profile not found.")
    return {
        "customerId": row["customer_id"],
        "fullName": row["full_name"],
        "email": mask_email(row["email"]),
        "mobile": mask_mobile(row["mobile"]),
        "city": row["city"],
        "address": row["address"],
        "kycStatus": row["kyc_status"],
        "customerSince": row["created_at"].date().isoformat(),
    }


class NewCustomer(BaseModel):
    customerId: str = Field(pattern=r"^VB\d{6}$")
    fullName: str
    email: str
    mobile: str = Field(pattern=r"^\d{10}$")
    dob: date
    address: str
    city: str


@app.post("/internal/customers", status_code=201)
def create(c: NewCustomer):
    """Internal (not routed by the gateway): used by the seed job."""
    with pool.connection() as conn:
        cur = conn.execute(
            """INSERT INTO customers (customer_id, full_name, email, mobile, dob, address, city)
               VALUES (%s, %s, %s, %s, %s, %s, %s) ON CONFLICT DO NOTHING""",
            (c.customerId, c.fullName, c.email, c.mobile, c.dob, c.address, c.city))
    return {"customerId": c.customerId, "created": cur.rowcount == 1}
