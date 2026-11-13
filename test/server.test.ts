import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalFor, createApprovalStore } from '../src/authorize.ts';
import { startAuthServer } from '../src/server.ts';
import { approvalDigest, approvalTerms, cardControls } from '../src/policy.ts';
import { invoice, policy, vendor } from '../src/demo-data.ts';

const SECRET = 'test-secret';
const cardId = 'card-under-test';
const sign = (nonce: string) => createHmac('sha256', SECRET).update(nonce).digest('base64');

async function startServer(answering = () => true, logDir?: string) {
  const store = createApprovalStore();
  const terms = approvalTerms(invoice, vendor, cardControls(invoice, vendor, policy), policy);
  store.arm(approvalFor(cardId, terms, approvalDigest(terms)));
  const logFile = join(logDir ?? mkdtempSync(join(tmpdir(), 'horos-')), 'auth.jsonl');
  const { server, log, stop } = startAuthServer({ store, secret: () => SECRET, port: 0, host: '127.0.0.1', logFile, answering });
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  return { port, log, logFile, close: stop };
}

const body = (overrides: Record<string, unknown> = {}) => ({
  card_id: cardId,
  card_transaction_event_id: randomUUID(),
  card_transaction_id: randomUUID(),
  transaction_type: 'AUTHORIZATION',
  transaction_amount: invoice.amount,
  transaction_currency: invoice.currency,
  merchant: { name: 'TESSALINE SYSTEMS INC____', category_code: vendor.mcc },
  ...overrides,
});

type Reply = { status: number; json?: { response_status: string; status_reason: string; card_transaction_event_id?: string } };

function post(port: number, chunks: Buffer[], headers: Record<string, string>): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/remote-auth', method: 'POST', headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : undefined }));
    });
    req.on('error', reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}

const signedPost = (port: number, payload: unknown, nonce = `${Date.now()}.${randomUUID()}`) =>
  post(port, [Buffer.from(JSON.stringify(payload))], { 'content-type': 'application/json', 'x-nonce': nonce, 'x-signature': sign(nonce) });

test('answers a signed matching authorization and echoes the event id', async () => {
  const s = await startServer();
  try {
    const payload = body();
    const reply = await signedPost(s.port, payload);
    assert.equal(reply.status, 200);
    assert.equal(reply.json?.response_status, 'AUTHORIZED');
    assert.equal(reply.json?.card_transaction_event_id, payload.card_transaction_event_id);
  } finally {
    s.close();
  }
});

test('refuses unsigned requests without recording their bodies', async () => {
  const s = await startServer();
  try {
    const reply = await post(s.port, [Buffer.from(JSON.stringify(body()))], { 'content-type': 'application/json', 'x-nonce': 'n', 'x-signature': 'bad' });
    assert.equal(reply.status, 401);
    assert.equal(reply.json?.status_reason, 'BAD_SIGNATURE');
    assert.equal(s.log.length, 0);
  } finally {
    s.close();
  }
});

test('a reused nonce on a different event is refused; a redelivery gets the same answer', async () => {
  const s = await startServer();
  try {
    const nonce = `${Date.now()}.fixed`;
    const first = body();
    assert.equal((await signedPost(s.port, first, nonce)).json?.response_status, 'AUTHORIZED');
    assert.equal((await signedPost(s.port, first, nonce)).json?.response_status, 'AUTHORIZED');
    assert.equal((await signedPost(s.port, body(), nonce)).json?.status_reason, 'NONCE_REUSED');
  } finally {
    s.close();
  }
});

test('refuses a signed request whose nonce timestamp is stale', async () => {
  const s = await startServer();
  try {
    const nonce = `${Date.now() - 10 * 60_000}.old`;
    assert.equal((await signedPost(s.port, body(), nonce)).json?.status_reason, 'STALE_NONCE');
    assert.equal((await signedPost(s.port, body())).json?.response_status, 'AUTHORIZED');
  } finally {
    s.close();
  }
});

test('a signed request with the wrong field types is refused and the server keeps serving', async () => {
  const s = await startServer();
  try {
    const crash = await signedPost(s.port, body({ merchant: { name: null, category_code: vendor.mcc } }));
    assert.equal(crash.json?.status_reason, 'MALFORMED_REQUEST');
    assert.equal((await signedPost(s.port, body())).json?.response_status, 'AUTHORIZED');
  } finally {
    s.close();
  }
});

test('rejects oversized bodies before parsing', async () => {
  const s = await startServer();
  try {
    const nonce = `${Date.now()}.big`;
    const reply = await post(s.port, [Buffer.alloc(200_000, 'a')], { 'x-nonce': nonce, 'x-signature': sign(nonce) }).catch(() => ({ status: 413 }));
    assert.equal(reply.status, 413);
  } finally {
    s.close();
  }
});

test('decodes a multi-byte merchant name split across packets', async () => {
  const s = await startServer();
  try {
    const nonce = `${Date.now()}.utf8`;
    const raw = Buffer.from(JSON.stringify(body({ merchant: { name: 'CAFÉ', category_code: vendor.mcc } })));
    const split = raw.indexOf(Buffer.from('É')) + 1;
    await post(s.port, [raw.subarray(0, split), raw.subarray(split)], { 'x-nonce': nonce, 'x-signature': sign(nonce) });
    assert.equal(s.log.at(-1)?.merchant, 'CAFÉ');
    await s.close();
    assert.ok(readFileSync(s.logFile, 'utf8').includes('CAFÉ'));
  } finally {
    await s.close();
  }
});

test('in outage mode the endpoint stays silent and drops the connection after the Airwallex window', async () => {
  const s = await startServer(() => false);
  try {
    const started = Date.now();
    await assert.rejects(signedPost(s.port, body()));
    const waited = Date.now() - started;
    assert.ok(waited >= 2500 && waited < 6000, `waited ${waited} ms`);
    assert.equal(s.log.at(-1)?.decision, 'NO_RESPONSE');
  } finally {
    s.close();
  }
});

test('a log write failure still answers and keeps the server up', async () => {
  const s = await startServer(() => true, '/nonexistent-horos-dir');
  try {
    assert.equal((await signedPost(s.port, body())).json?.response_status, 'AUTHORIZED');
    assert.equal((await signedPost(s.port, body())).json?.status_reason, 'APPROVAL_ALREADY_USED');
  } finally {
    s.close();
  }
});

test('a nonce seen during an outage cannot be replayed later', async () => {
  let answering = false;
  const s = await startServer(() => answering);
  try {
    const nonce = `${Date.now()}.outage`;
    await assert.rejects(signedPost(s.port, body(), nonce));
    answering = true;
    assert.equal((await signedPost(s.port, body(), nonce)).json?.status_reason, 'NONCE_REUSED');
  } finally {
    s.close();
  }
});
