// payment-service: bill payments. Fetch a bill from a (simulated) biller,
// pay it from a savings/current account after a step-up OTP, and keep history.
import crypto from 'node:crypto';
import amqp from 'amqplib';
import express from 'express';
import pg from 'pg';
import { BILLERS, fetchBill } from './billers.js';

const PORT = process.env.PORT || 8090;
const ACCOUNT_URL = process.env.ACCOUNT_URL || 'http://account-service:8083';
const AUTH_URL = process.env.AUTH_URL || 'http://auth-service:8081';
const LEDGER_URL = process.env.LEDGER_URL || 'http://ledger-service:8084';
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://vijaybank:vijaybank_pw@rabbitmq:5672';
const MAX_PAISE = 1_00_000 * 100; // ₹1,00,000 per bill

const log = (level, message, fields = {}) =>
  process.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), level, service: 'payment-service', message, ...fields }) + '\n');

class ApiError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    Object.assign(this, { status, code, details });
  }
}

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL || 'postgres://payment_svc:payment_pw@postgres:5432/payment' });

async function retry(name, fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= 30) throw err;
      log('WARN', `waiting for ${name}`, { attempt, error: err.message });
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

await retry('postgres', () =>
  db.query(`
    CREATE TABLE IF NOT EXISTS bill_payments (
      id               UUID PRIMARY KEY,
      customer_id      VARCHAR(16) NOT NULL,
      idempotency_key  VARCHAR(80) NOT NULL,
      reference        VARCHAR(24) NOT NULL UNIQUE,
      biller_id        VARCHAR(20) NOT NULL,
      biller_name      VARCHAR(60) NOT NULL,
      category         VARCHAR(20) NOT NULL,
      consumer_number  VARCHAR(20) NOT NULL,
      bill_number      VARCHAR(24),
      from_account     VARCHAR(20) NOT NULL,
      amount_paise     BIGINT NOT NULL CHECK (amount_paise > 0),
      status           VARCHAR(14) NOT NULL,
      failure_reason   VARCHAR(40),
      otp_ref          TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at     TIMESTAMPTZ,
      UNIQUE (customer_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS bill_payments_customer ON bill_payments (customer_id, created_at DESC);`),
);

// ------------------------------------------------------------------ events
let channel;
async function connectBroker() {
  const conn = await retry('rabbitmq', () => amqp.connect(RABBITMQ_URL));
  conn.on('close', () => {
    log('ERROR', 'rabbitmq connection closed, exiting so the container restarts');
    process.exit(1);
  });
  channel = await conn.createConfirmChannel();
}

async function publish(type, customerId, requestId, data) {
  const eventId = crypto.randomUUID();
  const body = Buffer.from(JSON.stringify({ eventId, type, occurredAt: new Date().toISOString(), customerId, requestId, data }));
  try {
    await new Promise((resolve, reject) =>
      channel.publish('vijaybank.events', type, body, { persistent: true, contentType: 'application/json', messageId: eventId, headers: { 'x-request-id': requestId } }, (err) =>
        err ? reject(err) : resolve(),
      ),
    );
  } catch (err) {
    log('ERROR', 'could not publish event', { requestId, type, error: err.message }); // notification only
  }
}

// ------------------------------------------------------------------ downstream
async function call(req, url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': req.requestId, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(8000),
  });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, body };
}

async function ownedAccount(req, accountNo) {
  const { status, body } = await call(req, `${ACCOUNT_URL}/internal/accounts/${encodeURIComponent(accountNo ?? '')}`);
  if (status === 404 || (status === 200 && body.customerId !== req.customerId)) throw new ApiError(404, 'ACCOUNT_NOT_FOUND', 'Account not found.');
  if (status !== 200) throw new ApiError(503, 'DEPENDENCY_UNAVAILABLE', 'Payments are temporarily unavailable.');
  if (body.status !== 'ACTIVE') throw new ApiError(422, 'ACCOUNT_INACTIVE', 'This account cannot be used for payments.');
  return body;
}

// ------------------------------------------------------------------ http
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  req.requestId = req.get('x-request-id') || crypto.randomUUID().replaceAll('-', '');
  req.customerId = req.get('x-customer-id');
  res.set('X-Request-Id', req.requestId);
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    if (!req.path.startsWith('/health')) {
      log('INFO', 'request', {
        requestId: req.requestId, customerId: req.customerId, method: req.method, path: req.path, status: res.statusCode,
        durationMs: Number((process.hrtime.bigint() - start) / 1_000_000n),
      });
    }
  });
  next();
});

const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);
const requireCustomer = (req) => {
  if (!req.customerId) throw new ApiError(401, 'UNAUTHENTICATED', 'Login required.');
};

const view = (r) => ({
  paymentId: r.id, reference: r.reference, billerId: r.biller_id, billerName: r.biller_name, category: r.category,
  consumerNumber: r.consumer_number, billNumber: r.bill_number, fromAccountNo: r.from_account,
  amountPaise: Number(r.amount_paise), status: r.status, failureReason: r.failure_reason, createdAt: r.created_at, completedAt: r.completed_at,
});

app.get('/health/live', (_req, res) => res.json({ status: 'UP' }));
app.get('/health/ready', wrap(async (_req, res) => {
  await db.query('SELECT 1');
  res.json({ status: channel ? 'UP' : 'STARTING' });
}));

app.get('/billers', (_req, res) => res.json(BILLERS.map(({ pattern, ...b }) => ({ ...b, pattern }))));

app.post('/bill-payments/fetch', wrap(async (req, res) => {
  requireCustomer(req);
  const biller = BILLERS.find((b) => b.id === req.body.billerId);
  const consumerNumber = String(req.body.consumerNumber ?? '').trim().toUpperCase();
  if (!biller) throw new ApiError(404, 'BILLER_NOT_FOUND', 'Biller not found.');
  if (!new RegExp(biller.pattern).test(consumerNumber)) throw new ApiError(400, 'INVALID_CONSUMER_NUMBER', `Enter a valid ${biller.label.toLowerCase()}.`);
  res.json({ billerId: biller.id, billerName: biller.name, consumerNumber, ...fetchBill(biller, consumerNumber) });
}));

app.post('/bill-payments', wrap(async (req, res) => {
  requireCustomer(req);
  const key = req.get('idempotency-key');
  if (!key || key.length > 80) throw new ApiError(400, 'INVALID_REQUEST', 'An Idempotency-Key header is required.');
  const prior = await db.query('SELECT * FROM bill_payments WHERE customer_id = $1 AND idempotency_key = $2', [req.customerId, key]);
  if (prior.rowCount) return res.status(200).json(view(prior.rows[0]));

  const biller = BILLERS.find((b) => b.id === req.body.billerId);
  const consumerNumber = String(req.body.consumerNumber ?? '').trim().toUpperCase();
  const amount = Number(req.body.amountPaise);
  if (!biller) throw new ApiError(404, 'BILLER_NOT_FOUND', 'Biller not found.');
  if (!new RegExp(biller.pattern).test(consumerNumber)) throw new ApiError(400, 'INVALID_CONSUMER_NUMBER', `Enter a valid ${biller.label.toLowerCase()}.`);
  if (!Number.isInteger(amount) || amount < 100 || amount > MAX_PAISE) throw new ApiError(422, 'AMOUNT_OUT_OF_RANGE', 'Bill amount must be between ₹1 and ₹1,00,000.');
  const bill = fetchBill(biller, consumerNumber);
  if (!bill.recharge && bill.dueAmountPaise === 0) throw new ApiError(422, 'NO_BILL_DUE', 'There is no bill due for this number.');
  const account = await ownedAccount(req, req.body.fromAccountNo);

  const id = crypto.randomUUID();
  const reference = `VBB${new Date(Date.now() + 19_800_000).toISOString().slice(2, 10).replaceAll('-', '')}${crypto.randomInt(1_000_000).toString().padStart(6, '0')}`;
  try {
    await db.query(
      `INSERT INTO bill_payments (id, customer_id, idempotency_key, reference, biller_id, biller_name, category, consumer_number, bill_number, from_account, amount_paise, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'OTP_REQUIRED')`,
      [id, req.customerId, key, reference, biller.id, biller.name, biller.category, consumerNumber, bill.billNumber, account.accountNo, amount],
    );
  } catch (err) {
    if (err.code === '23505') {
      const again = await db.query('SELECT * FROM bill_payments WHERE customer_id = $1 AND idempotency_key = $2', [req.customerId, key]);
      return res.status(200).json(view(again.rows[0]));
    }
    throw err;
  }
  const otp = await call(req, `${AUTH_URL}/internal/otp/send`, {
    method: 'POST',
    body: JSON.stringify({ customerId: req.customerId, purpose: 'BILLPAY', details: { amountPaise: amount, billerName: biller.name } }),
  });
  if (otp.status !== 200) throw new ApiError(503, 'DEPENDENCY_UNAVAILABLE', 'Could not send the OTP. Please try again.');
  await db.query('UPDATE bill_payments SET otp_ref = $2 WHERE id = $1', [id, otp.body.otpRef]);
  const row = await db.query('SELECT * FROM bill_payments WHERE id = $1', [id]);
  res.status(202).json(view(row.rows[0]));
}));

app.post('/bill-payments/:id/confirm', wrap(async (req, res) => {
  requireCustomer(req);
  const found = await db.query('SELECT * FROM bill_payments WHERE id = $1 AND customer_id = $2', [req.params.id, req.customerId]);
  if (!found.rowCount) throw new ApiError(404, 'NOT_FOUND', 'Payment not found.');
  const p = found.rows[0];
  if (p.status !== 'OTP_REQUIRED') return res.json(view(p));

  const v = await call(req, `${AUTH_URL}/internal/otp/verify`, {
    method: 'POST',
    body: JSON.stringify({ otpRef: p.otp_ref, customerId: req.customerId, purpose: 'BILLPAY', otp: String(req.body.otp ?? '') }),
  });
  if (v.status >= 400 && v.status < 500) {
    const e = v.body?.error ?? {};
    const { code, message, requestId, ...details } = e;
    throw new ApiError(v.status, code ?? 'INVALID_OTP', message ?? 'OTP verification failed.', details);
  }
  if (v.status !== 200) throw new ApiError(503, 'DEPENDENCY_UNAVAILABLE', 'Could not verify the OTP. Please try again.');

  const claimed = await db.query("UPDATE bill_payments SET status = 'PROCESSING' WHERE id = $1 AND status = 'OTP_REQUIRED' RETURNING *", [p.id]);
  if (!claimed.rowCount) return res.json(view((await db.query('SELECT * FROM bill_payments WHERE id = $1', [p.id])).rows[0]));

  let posted;
  try {
    posted = await call(req, `${LEDGER_URL}/internal/journals`, {
      method: 'POST',
      body: JSON.stringify({
        idempotencyKey: `billpay:${p.id}`, type: 'BILL_PAYMENT', reference: p.reference,
        entries: [
          { accountNo: p.from_account, direction: 'DEBIT', amountPaise: Number(p.amount_paise), narration: `BILLPAY/${p.biller_name.toUpperCase()}/${p.consumer_number}` },
          { accountNo: 'BILLPAY_SETTLEMENT', direction: 'CREDIT', amountPaise: Number(p.amount_paise), narration: `BILLPAY ${p.reference}` },
        ],
      }),
    });
  } catch (err) {
    // Timeout: the posting may have happened. Leave PROCESSING; retrying with the same key is safe.
    log('ERROR', 'ledger outcome unknown', { requestId: req.requestId, paymentId: p.id, error: err.message });
    throw new ApiError(503, 'OUTCOME_UNKNOWN', 'Your payment is being processed. Check its status shortly before trying again.');
  }
  const data = { paymentId: p.id, reference: p.reference, billerName: p.biller_name, category: p.category, consumerNumber: p.consumer_number, amountPaise: Number(p.amount_paise), fromAccountNo: p.from_account };
  if (posted.status === 201 || posted.status === 200) {
    await db.query("UPDATE bill_payments SET status = 'COMPLETED', completed_at = now() WHERE id = $1", [p.id]);
    await publish('billpay.completed', req.customerId, req.requestId, data);
  } else if (posted.status >= 400 && posted.status < 500) {
    const reason = posted.body?.error?.code ?? 'REJECTED';
    await db.query("UPDATE bill_payments SET status = 'FAILED', failure_reason = $2 WHERE id = $1", [p.id, reason]);
    await publish('billpay.failed', req.customerId, req.requestId, { ...data, reason });
    throw new ApiError(422, reason, reason === 'INSUFFICIENT_FUNDS' ? 'Insufficient balance in the selected account.' : 'The payment could not be completed.');
  } else {
    throw new ApiError(503, 'OUTCOME_UNKNOWN', 'Your payment is being processed. Check its status shortly before trying again.');
  }
  log('INFO', 'bill paid', { requestId: req.requestId, paymentId: p.id, billerId: p.biller_id });
  res.json(view((await db.query('SELECT * FROM bill_payments WHERE id = $1', [p.id])).rows[0]));
}));

app.get('/bill-payments', wrap(async (req, res) => {
  requireCustomer(req);
  const r = await db.query("SELECT * FROM bill_payments WHERE customer_id = $1 AND status <> 'OTP_REQUIRED' ORDER BY created_at DESC LIMIT 20", [req.customerId]);
  res.json(r.rows.map(view));
}));

app.use((err, req, res, _next) => {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, requestId: req.requestId, ...err.details } });
  }
  log('ERROR', 'unhandled error', { requestId: req.requestId, error: err.message });
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.', requestId: req.requestId } });
});

await connectBroker();
app.listen(PORT, () => log('INFO', 'listening', { port: PORT }));
