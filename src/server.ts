import { createServer, type Server, type ServerResponse } from 'node:http';
import { createWriteStream } from 'node:fs';
import { createApprovalStore, nonceIsFresh, verifySignature, type AuthRequest, type Decision } from './authorize.ts';

export type AuthLogEntry = {
  at: string;
  signed: boolean;
  cardId?: string;
  eventId?: string;
  transactionId?: string;
  transactionType?: string;
  merchant?: string;
  // Payee identity as the acquirer reports it; logged so a descriptor match can be compared with who was really paid.
  merchantId?: string;
  acquirerId?: string;
  acquirerMerchantId?: string;
  amount?: number;
  currency?: string;
  decision: Decision | 'NO_RESPONSE';
  ms: number;
};

type Options = {
  store: ReturnType<typeof createApprovalStore>;
  secret: () => string;
  port: number;
  host?: string;
  logFile: string;
  // When false the endpoint stays silent, so Airwallex must fall back to its default action.
  answering: () => boolean;
};

const MAX_BODY_BYTES = 64 * 1024;
const NONCE_TTL_MS = 10 * 60_000;
// Airwallex waits 2.5 s; holding a silent connection longer only ties up sockets.
const SILENT_DROP_MS = 3_000;
const LOG_LIMIT = 1_000;

const declined = (status_reason: string): Decision => ({ response_status: 'DECLINED', status_reason });

function reply(res: ServerResponse, status: number, eventId: unknown, decision: Decision) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ card_transaction_event_id: eventId, ...decision }));
}

export function startAuthServer({ store, secret, port, host, logFile, answering }: Options) {
  const log: AuthLogEntry[] = [];
  const seenNonces = new Map<string, { eventId: string; at: number }>();
  let unsignedRejected = 0;

  // The answer is already sent when this runs. Writes are queued, so a slow disk never delays the next decision,
  // and a failed write is reported without taking the endpoint down.
  const file = createWriteStream(logFile, { flags: 'a' });
  file.on('error', (e) => console.error(`auth log write failed: ${e.message}`));
  const record = (entry: AuthLogEntry) => {
    log.push(entry);
    if (log.length > LOG_LIMIT) log.shift();
    if (!file.destroyed) file.write(JSON.stringify(entry) + '\n');
  };

  const server: Server = createServer((req, res) => {
    const started = Date.now();
    const silent = !answering();
    const nonce = String(req.headers['x-nonce'] ?? '');
    if (!verifySignature(secret(), nonce, String(req.headers['x-signature'] ?? ''))) {
      unsignedRejected++;
      reply(res, 401, undefined, declined('BAD_SIGNATURE'));
      req.destroy();
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reply(res, 413, undefined, declined('BODY_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > MAX_BODY_BYTES) return;
      let body: (AuthRequest & { card_transaction_id?: string; merchant_id?: string; acquiring_institution_id?: string }) | undefined;
      let decision: Decision = declined('MALFORMED_REQUEST');
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const eventId = typeof body?.card_transaction_event_id === 'string' ? body.card_transaction_event_id : '';
        for (const [n, seen] of seenNonces) if (started - seen.at > NONCE_TTL_MS) seenNonces.delete(n);
        const seen = seenNonces.get(nonce);
        if (!nonceIsFresh(nonce, started)) decision = declined('STALE_NONCE');
        else if (seen && seen.eventId !== eventId) decision = declined('NONCE_REUSED');
        else {
          // Recorded even while silent, so a nonce dropped during an outage cannot be replayed later.
          seenNonces.set(nonce, { eventId, at: started });
          if (!silent) decision = store.authorize(body as AuthRequest);
        }
      } catch {
        decision = declined('MALFORMED_REQUEST');
      }

      if (silent) setTimeout(() => req.socket.destroy(), SILENT_DROP_MS).unref();
      else reply(res, 200, body?.card_transaction_event_id, decision);
      record({
        at: new Date(started).toISOString(),
        signed: true,
        cardId: body?.card_id,
        eventId: body?.card_transaction_event_id,
        transactionId: body?.card_transaction_id,
        transactionType: body?.transaction_type,
        merchant: body?.merchant?.name,
        merchantId: body?.merchant?.id,
        acquirerId: body?.acquiring_institution_id,
        acquirerMerchantId: body?.merchant_id,
        amount: body?.transaction_amount,
        currency: body?.transaction_currency,
        decision: silent ? 'NO_RESPONSE' : decision,
        ms: Date.now() - started,
      });
    });
  });
  server.listen(port, host);
  // Resolves once the server is closed and every queued log line is on disk.
  const stop = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => (file.destroyed ? resolve() : file.end(resolve)));
    });
  return { server, log, stop, unsignedRejected: () => unsignedRejected };
}
