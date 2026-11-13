import { randomUUID } from 'node:crypto';
import * as awx from './airwallex.ts';
import type { Ledger } from './ledger.ts';
import type { CardControls } from './policy.ts';

const PREVIOUS_REMOTE_AUTH = 'remote_auth_before_run';
// An empty lookup proves a lost create never happened only once the provider has surely finished with it.
const CREATE_SETTLE_MS = Number(process.env.HOROS_CREATE_SETTLE_MS ?? 600_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Aborted extends Error {
  constructor() {
    super('ABORTED');
  }
}

// Every action that can create a card or move money goes through here. Once stop() is called nothing new starts,
// and drain() reports whether everything already in flight has answered.
export function cardSession(ledger: Ledger, cardholderId: string) {
  let stopping = false;
  const inflight = new Set<Promise<unknown>>();
  const guarded = <T>(work: () => Promise<T>): Promise<T> => {
    if (stopping) return Promise.reject(new Aborted());
    const p = work();
    inflight.add(p);
    p.then(
      () => inflight.delete(p),
      () => inflight.delete(p),
    );
    return p;
  };
  return {
    stop: () => void (stopping = true),
    drain: async (timeoutMs: number) => {
      const done = Promise.allSettled([...inflight]).then(() => true);
      return Promise.race([done, sleep(timeoutMs).then(() => inflight.size === 0)]);
    },
    issue: (label: string, controls: CardControls, requestId: string = randomUUID()) =>
      guarded(async () => {
        ledger.card(requestId, label, null, 'REQUESTED');
        const card = await awx.issueCard(cardholderId, controls, `horos:${label}`, requestId);
        ledger.card(requestId, label, card.card_id, card.card_status);
        return card;
      }),
    charge: (cardId: string, charge: Parameters<typeof awx.simulateAuthorization>[1]) => guarded(() => awx.simulateAuthorization(cardId, charge)),
    capture: (lifecycleId: string, merchantInfo: string, amount?: number) => guarded(() => awx.simulateCapture(lifecycleId, merchantInfo, amount)),
  };
}

// Closes the cards Horos created and nothing else: each inventory row by its card id, or, when the create response
// was lost, by the nick name that carries its request id. Only a CLOSED read-back counts.
export async function closeAllCards(ledger: Ledger) {
  const cards: { requestId: string; id: string | null; status: string }[] = [];
  for (const row of ledger.openCards()) {
    const ids = row.card_id
      ? [row.card_id]
      : await awx.cardsByNickName(awx.nickNameFor(row.request_id)).then(
          (found) => found.map((c) => c.card_id),
          () => undefined,
        );
    if (!ids) {
      cards.push({ requestId: row.request_id, id: null, status: 'LOOKUP_FAILED' });
      continue;
    }
    if (ids.length === 0) {
      const settled = Date.now() - Date.parse(row.at) > CREATE_SETTLE_MS;
      if (settled) ledger.card(row.request_id, row.label, null, 'CLOSED');
      cards.push({ requestId: row.request_id, id: null, status: settled ? 'NOT_CREATED' : 'CREATE_PENDING' });
    }
    for (const id of ids) {
      await awx.closeCard(id).catch(() => undefined);
      const status = await awx.getCard(id).then((c) => c.card_status, () => 'UNREADABLE');
      if (status === 'CLOSED') ledger.card(row.request_id, row.label, id, 'CLOSED');
      cards.push({ requestId: row.request_id, id, status });
    }
  }
  return { allClosed: cards.every((c) => c.status === 'CLOSED' || c.status === 'NOT_CREATED'), cards };
}

const remoteAuthOf = (c: Awaited<ReturnType<typeof awx.issuingConfig>>) => c.remote_auth_settings ?? c.remote_auth;

// The setting before the first run that changed it. A run that crashed leaves it saved, so the next run or
// `horos.ts cleanup` restores the true original rather than the crashed run's state.
export async function rememberRemoteAuth(ledger: Ledger) {
  const current = remoteAuthOf(await awx.issuingConfig()) ?? { enabled: false };
  if (!ledger.setting(PREVIOUS_REMOTE_AUTH)) {
    ledger.setSetting(PREVIOUS_REMOTE_AUTH, JSON.stringify({ enabled: current.enabled, url: current.url, default_action: current.default_action, version: current.version }));
  }
  return JSON.parse(ledger.setting(PREVIOUS_REMOTE_AUTH)!) as awx.RemoteAuthSettings;
}

const sameSettings = (a: awx.RemoteAuthSettings, b: awx.RemoteAuthSettings) =>
  a.enabled === b.enabled &&
  (a.url === undefined || a.url === b.url) &&
  (a.default_action === undefined || a.default_action === b.default_action) &&
  (a.version === undefined || b.version === undefined || a.version === b.version);

// Restores exactly what was saved, and clears the saved copy only once every field reads back. With nothing saved,
// nothing was changed, so nothing is written.
export async function restoreRemoteAuth(ledger: Ledger, fallbackUrl: string) {
  const saved = ledger.setting(PREVIOUS_REMOTE_AUTH);
  if (!saved) return { restored: true, readBack: 'NO_SAVED_SETTING' as const, error: undefined };
  const previous: awx.RemoteAuthSettings = JSON.parse(saved);
  const write = { enabled: previous.enabled, url: previous.url ?? fallbackUrl, default_action: previous.default_action ?? 'DECLINED', ...(previous.version ? { version: previous.version } : {}) };
  const error = await awx.updateRemoteAuth(write).then(
    () => undefined,
    (e) => (e as Error).message,
  );
  if (error) return { restored: false, readBack: 'NOT_WRITTEN' as const, error };
  // Airwallex's config read lags the write by a few seconds; it counts as restored only once it reads back.
  for (let i = 0; i < 10; i++) {
    const now = await awx.issuingConfig().then(remoteAuthOf, () => undefined);
    if (now && sameSettings(previous, now)) {
      ledger.setSetting(PREVIOUS_REMOTE_AUTH, null);
      return { restored: true, readBack: { enabled: now.enabled, url: now.url, default_action: now.default_action, readBackAfterMs: i * 2000 }, error };
    }
    await sleep(2000);
  }
  return { restored: false, readBack: 'NOT_CONFIRMED' as const, error };
}
