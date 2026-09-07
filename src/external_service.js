/**
 * Stand-in for a CRM API or mail provider.
 *
 * The important property is that it deduplicates on the idempotency key the caller
 * supplies, the way Stripe, SendGrid and HubSpot all do. That is what makes a safe
 * retry possible at all: without server-side dedupe, no amount of client-side care
 * can stop a second call from creating a second record.
 *
 * `faults` lets a test simulate the case that matters: the service commits the write
 * and *then* the connection dies, so the caller never learns the outcome.
 */
const committed = new Map();   // idempotency_key -> { external_ref, type, payload, at }
let counter = 0;

export const faults = {
  timeoutAfterCommit: false,   // commit, then throw as if the socket died
  failBeforeCommit: false,     // throw without committing anything
  lookupFails: false,          // reconciliation endpoint unreachable
  delayMs: 0
};

export function resetService() {
  committed.clear();
  counter = 0;
  faults.timeoutAfterCommit = false;
  faults.failBeforeCommit = false;
  faults.lookupFails = false;
  faults.delayMs = 0;
}

export class TransportTimeout extends Error {
  constructor(message) {
    super(message);
    this.name = 'TransportTimeout';
    this.code = 'ETIMEDOUT';
  }
}

/** Everything the service has actually committed. Tests assert on this. */
export const committedCount = () => committed.size;
export const committedFor = (key) => committed.get(key) ?? null;

/**
 * Called by the pipeline. Throws TransportTimeout when the outcome is unknowable
 * from the caller's side.
 */
export async function callExternal(type, payload, idempotencyKey) {
  if (!idempotencyKey) throw new Error('idempotency key is required');
  if (faults.delayMs) await new Promise((r) => setTimeout(r, faults.delayMs));

  if (faults.failBeforeCommit) {
    throw new TransportTimeout('connection reset before the request was accepted');
  }

  // Server-side replay protection: the same key never commits twice.
  const existing = committed.get(idempotencyKey);
  if (existing) {
    if (faults.timeoutAfterCommit) throw new TransportTimeout('response lost after commit');
    return { external_ref: existing.external_ref, replayed: true };
  }

  const external_ref = `${type}_${String(++counter).padStart(4, '0')}`;
  committed.set(idempotencyKey, { external_ref, type, payload, at: new Date().toISOString() });

  if (faults.timeoutAfterCommit) {
    // Committed, but the caller will never see this return value.
    throw new TransportTimeout('response lost after commit');
  }
  return { external_ref, replayed: false };
}

/**
 * Reconciliation endpoint. After an unknown outcome the caller asks the service what
 * actually happened for a given key instead of guessing or blindly retrying.
 */
export async function lookupByIdempotencyKey(idempotencyKey) {
  if (faults.delayMs) await new Promise((r) => setTimeout(r, faults.delayMs));
  if (faults.lookupFails) throw new TransportTimeout('reconciliation endpoint unreachable');
  const rec = committed.get(idempotencyKey);
  return rec ? { found: true, external_ref: rec.external_ref, at: rec.at } : { found: false };
}
