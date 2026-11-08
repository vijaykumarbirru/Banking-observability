"""audit-service: append-only audit trail of every domain event.

Consumes the audit.all queue (bound to '#') in a background thread and stores
events in MongoDB. Secrets such as OTPs are removed before storing. Nothing is
ever updated or deleted.
"""

import json
import logging
import os
import threading
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import pika
from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse
from pymongo import DESCENDING, MongoClient
from pymongo.errors import DuplicateKeyError
from pythonjsonlogger import jsonlogger

handler = logging.StreamHandler()
handler.setFormatter(jsonlogger.JsonFormatter(
    "%(asctime)s %(levelname)s %(name)s %(message)s",
    rename_fields={"asctime": "timestamp", "levelname": "level"},
    static_fields={"service": "audit-service"}))
# Add (not replace) so the OpenTelemetry log handler, when present, keeps shipping logs.
logging.getLogger().setLevel(logging.INFO)
logging.getLogger().addHandler(handler)
logging.getLogger("pika").setLevel(logging.WARNING)
log = logging.getLogger("audit")

QUEUE = "audit.all"
SECRET_FIELDS = {"otp", "password", "cvv", "pin"}

mongo = MongoClient(os.getenv("MONGO_URL", "mongodb://mongodb:27017"), serverSelectionTimeoutMS=5000)
events = mongo["audit"]["events"]
state = {"consuming": False}


def scrub(value):
    if isinstance(value, dict):
        return {k: ("[REDACTED]" if k.lower() in SECRET_FIELDS else scrub(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [scrub(v) for v in value]
    return value


def on_message(channel, method, properties, body):
    try:
        event = json.loads(body)
        doc = scrub(event)
        doc["_id"] = event["eventId"]  # natural key: redeliveries are ignored
        doc["receivedAt"] = datetime.now(timezone.utc)
        try:
            events.insert_one(doc)
        except DuplicateKeyError:
            pass
        channel.basic_ack(method.delivery_tag)
    except Exception as e:  # noqa: BLE001 — park poison messages in the DLQ
        log.error("could not store event, dead-lettering", extra={"error": str(e)})
        channel.basic_nack(method.delivery_tag, requeue=False)


def consume_forever():
    params = pika.URLParameters(os.getenv("RABBITMQ_URL", "amqp://vijaybank:vijaybank_pw@rabbitmq:5672/%2F"))
    params.heartbeat = 30
    while True:
        try:
            conn = pika.BlockingConnection(params)
            ch = conn.channel()
            ch.basic_qos(prefetch_count=50)
            ch.basic_consume(QUEUE, on_message)
            state["consuming"] = True
            log.info("consuming", extra={"queue": QUEUE})
            ch.start_consuming()
        except Exception as e:  # noqa: BLE001 — reconnect on any broker failure
            state["consuming"] = False
            log.warning("rabbitmq unavailable, retrying", extra={"error": str(e)})
            time.sleep(3)


@asynccontextmanager
async def lifespan(_app):
    events.create_index([("customerId", 1), ("occurredAt", DESCENDING)])
    events.create_index([("type", 1), ("occurredAt", DESCENDING)])
    threading.Thread(target=consume_forever, daemon=True).start()
    yield


app = FastAPI(title="audit-service", lifespan=lifespan)


@app.get("/health/live")
def live():
    return {"status": "UP"}


@app.get("/health/ready")
def ready():
    try:
        mongo.admin.command("ping")
    except Exception:  # noqa: BLE001
        return JSONResponse(status_code=503, content={"status": "DOWN"})
    return {"status": "UP" if state["consuming"] else "STARTING"}


@app.get("/internal/audit")
def audit(customerId: str | None = None, type: str | None = None, limit: int = Query(50, le=500)):
    """Internal: read the trail, newest first."""
    q = {k: v for k, v in {"customerId": customerId, "type": type}.items() if v}
    docs = events.find(q, {"_id": 0}).sort("occurredAt", DESCENDING).limit(limit)
    return [{**d, "receivedAt": d["receivedAt"].isoformat()} for d in docs]
