"""fraud-service: rule-based risk score (0-100) for every transfer.

>= 80 -> BLOCK, 50-79 -> ALLOW but FLAG (fraud.flagged event), < 50 -> ALLOW.
Stateless: transfer-service sends the features it already knows.
"""

import json
import logging
import os
import threading
import time
import uuid
from contextvars import ContextVar
from datetime import datetime, timedelta, timezone

import pika
from fastapi import FastAPI, Request
from pydantic import BaseModel
from pythonjsonlogger import jsonlogger

request_id: ContextVar[str] = ContextVar("request_id", default="")
IST = timezone(timedelta(hours=5, minutes=30))
BLOCK_AT = int(os.getenv("FRAUD_BLOCK_SCORE", "80"))
FLAG_AT = int(os.getenv("FRAUD_FLAG_SCORE", "50"))


class ContextFilter(logging.Filter):
    def filter(self, record):
        record.service = "fraud-service"
        record.requestId = request_id.get()
        return True


handler = logging.StreamHandler()
handler.setFormatter(jsonlogger.JsonFormatter(
    "%(asctime)s %(levelname)s %(name)s %(message)s",
    rename_fields={"asctime": "timestamp", "levelname": "level"}))
handler.addFilter(ContextFilter())
logging.basicConfig(level=logging.INFO, handlers=[handler], force=True)
logging.getLogger("pika").setLevel(logging.WARNING)
log = logging.getLogger("fraud")

app = FastAPI(title="fraud-service")


class Publisher:
    """Publishes to RabbitMQ with confirms. pika is not thread-safe, so calls are serialised."""

    def __init__(self, url: str):
        self.params = pika.URLParameters(url)
        self.params.socket_timeout = 3
        self.params.connection_attempts = 1
        self.lock = threading.Lock()
        self.channel = None

    def _connect(self):
        conn = pika.BlockingConnection(self.params)
        ch = conn.channel()
        ch.confirm_delivery()
        self.channel = ch

    def publish(self, event_type: str, customer_id: str, data: dict):
        event = {"eventId": str(uuid.uuid4()), "type": event_type,
                 "occurredAt": datetime.now(timezone.utc).isoformat(), "customerId": customer_id,
                 "requestId": request_id.get(), "data": data}
        props = pika.BasicProperties(content_type="application/json", delivery_mode=2,
                                     message_id=event["eventId"], headers={"x-request-id": request_id.get()})
        with self.lock:
            for attempt in range(2):
                try:
                    if self.channel is None or self.channel.is_closed:
                        self._connect()
                    self.channel.basic_publish("vijaybank.events", event_type, json.dumps(event).encode(), props)
                    return
                except pika.exceptions.AMQPError:
                    self.channel = None
                    if attempt:
                        raise


publisher = Publisher(os.getenv("RABBITMQ_URL", "amqp://vijaybank:vijaybank_pw@rabbitmq:5672/%2F"))


@app.middleware("http")
async def request_context(request: Request, call_next):
    rid = request.headers.get("x-request-id") or uuid.uuid4().hex
    request_id.set(rid)
    start = time.perf_counter()
    response = await call_next(request)
    response.headers["X-Request-Id"] = rid
    if not request.url.path.startswith("/health"):
        log.info("request", extra={"method": request.method, "path": request.url.path,
                                   "status": response.status_code,
                                   "durationMs": round((time.perf_counter() - start) * 1000)})
    return response


class ScoreRequest(BaseModel):
    transferId: str
    customerId: str
    mode: str
    amountPaise: int
    beneficiaryAgeHours: float | None = None   # None for own-account transfers
    recentTransferCount10m: int = 0
    firstTransferToBank: bool = False


RULES = [
    ("HIGH_AMOUNT", 30, lambda r, now: r.amountPaise > 2_00_000_00),
    ("NEW_BENEFICIARY", 25, lambda r, now: r.beneficiaryAgeHours is not None and r.beneficiaryAgeHours < 24),
    ("HIGH_VELOCITY", 30, lambda r, now: r.recentTransferCount10m > 5),
    ("FIRST_TRANSFER_TO_BANK", 10, lambda r, now: r.firstTransferToBank),
    ("ODD_HOURS", 10, lambda r, now: now.hour < 5),
]


@app.post("/score")
def score(req: ScoreRequest):
    now = datetime.now(IST)
    hits = [(name, points) for name, points, rule in RULES if rule(req, now)]
    total = min(100, sum(p for _, p in hits))
    decision = "BLOCK" if total >= BLOCK_AT else "FLAG" if total >= FLAG_AT else "ALLOW"
    result = {"transferId": req.transferId, "score": total, "decision": decision, "rules": [n for n, _ in hits]}
    log.info("scored", extra={"transferId": req.transferId, "customerId": req.customerId,
                              "score": total, "decision": decision, "rules": result["rules"]})
    if decision != "ALLOW":
        try:
            publisher.publish("fraud.flagged", req.customerId, {**result, "mode": req.mode, "amountPaise": req.amountPaise})
        except Exception as e:  # noqa: BLE001 — the decision must not depend on the broker
            log.error("could not publish fraud.flagged", extra={"error": str(e)})
    return result


@app.get("/health/live")
def live():
    return {"status": "UP"}


@app.get("/health/ready")
def ready():
    return {"status": "UP"}
