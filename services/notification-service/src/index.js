// notification-service: consumes domain events from RabbitMQ and "delivers"
// simulated SMS / e-mail by storing them in MongoDB. Exposes the history to
// customers and a lab-only developer inbox for reading OTPs locally.
import crypto from 'node:crypto';
import amqp from 'amqplib';
import express from 'express';
import { MongoClient } from 'mongodb';
import { log } from './log.js';
import { mask, render } from './templates.js';

const PORT = process.env.PORT || 8087;
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://vijaybank:vijaybank_pw@rabbitmq:5672';
const MONGO_URL = process.env.MONGO_URL || 'mongodb://mongodb:27017';
const QUEUE = 'notification.events';
const MAX_RETRIES = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function retry(name, fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= 30) throw err;
      log.warn(`waiting for ${name}`, { attempt, error: err.message });
      await sleep(2000);
    }
  }
}

const mongo = await retry('mongodb', () => new MongoClient(MONGO_URL).connect());
const notifications = mongo.db('notifications').collection('notifications');
await notifications.createIndex({ eventId: 1 }, { unique: true });
await notifications.createIndex({ customerId: 1, createdAt: -1 });

let channel;

async function handle(msg) {
  const requestId = msg.properties.headers?.['x-request-id'];
  let event;
  try {
    event = JSON.parse(msg.content.toString());
  } catch {
    log.error('unparseable message, dead-lettering', { requestId });
    channel.nack(msg, false, false);
    return;
  }
  try {
    const n = render(event);
    if (n) {
      await notifications.insertOne({
        eventId: event.eventId,
        customerId: event.customerId,
        eventType: event.type,
        channel: n.channel,
        message: n.message,
        maskedMessage: mask(n.message, n.sensitive),
        requestId,
        createdAt: new Date(),
      });
      // Never log the message body: it can contain an OTP.
      log.info('notification delivered', { requestId, customerId: event.customerId, eventType: event.type, channel: n.channel });
    }
    channel.ack(msg);
  } catch (err) {
    if (err.code === 11000) {
      // Duplicate delivery of an event we already handled: safe to drop.
      channel.ack(msg);
      return;
    }
    const retries = (msg.properties.headers?.['x-retries'] ?? 0) + 1;
    if (retries > MAX_RETRIES) {
      log.error('giving up, dead-lettering', { requestId, eventType: event.type, error: err.message });
      channel.nack(msg, false, false);
      return;
    }
    log.warn('handling failed, retrying', { requestId, eventType: event.type, retries, error: err.message });
    channel.sendToQueue(QUEUE, msg.content, {
      ...msg.properties,
      headers: { ...msg.properties.headers, 'x-retries': retries },
    });
    channel.ack(msg);
  }
}

async function startConsumer() {
  const conn = await retry('rabbitmq', () => amqp.connect(RABBITMQ_URL));
  conn.on('close', () => {
    log.error('rabbitmq connection closed, exiting so the container restarts');
    process.exit(1);
  });
  channel = await conn.createChannel();
  await channel.prefetch(10);
  await channel.consume(QUEUE, (msg) => msg && handle(msg), { noAck: false });
  log.info('consuming', { queue: QUEUE });
}

const app = express();

app.use((req, res, next) => {
  req.requestId = req.get('x-request-id') || crypto.randomUUID().replaceAll('-', '');
  res.set('X-Request-Id', req.requestId);
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    if (!req.path.startsWith('/health')) {
      log.info('request', {
        requestId: req.requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Number((process.hrtime.bigint() - start) / 1_000_000n),
      });
    }
  });
  next();
});

const error = (req, res, status, code, message) =>
  res.status(status).json({ error: { code, message, requestId: req.requestId } });

app.get('/health/live', (_req, res) => res.json({ status: 'UP' }));
app.get('/health/ready', async (_req, res) => {
  try {
    await mongo.db('admin').command({ ping: 1 });
    res.json({ status: channel ? 'UP' : 'STARTING' });
  } catch {
    res.status(503).json({ status: 'DOWN' });
  }
});

// Lab-only: simulated SMS inbox so OTPs can be read without a phone.
app.get('/notifications/dev-inbox', async (req, res) => {
  const customerId = req.query.customerId;
  if (!/^VB\d{6}$/.test(customerId ?? '')) return error(req, res, 400, 'INVALID_REQUEST', 'customerId is required');
  const since = new Date(Date.now() - 10 * 60 * 1000);
  const items = await notifications
    .find({ customerId, channel: 'SMS', createdAt: { $gte: since } }, { projection: { _id: 0, message: 1, createdAt: 1 } })
    .sort({ createdAt: -1 })
    .limit(5)
    .toArray();
  res.json(items);
});

app.get('/notifications', async (req, res) => {
  const customerId = req.get('x-customer-id');
  if (!customerId) return error(req, res, 401, 'UNAUTHENTICATED', 'Login required.');
  const items = await notifications
    .find({ customerId }, { projection: { _id: 0, eventType: 1, channel: 1, maskedMessage: 1, createdAt: 1 } })
    .sort({ createdAt: -1 })
    .limit(50)
    .toArray();
  res.json(items.map(({ maskedMessage, ...rest }) => ({ ...rest, message: maskedMessage })));
});

app.listen(PORT, () => log.info('listening', { port: PORT }));
await startConsumer();
