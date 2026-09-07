import crypto from 'node:crypto';
import { db } from './db.js';
import { audit, now } from './normalise.js';
import { callExternal, lookupByIdempotencyKey, TransportTimeout } from './external_service.js';

db.exec(`
CREATE TABLE IF NOT EXISTS external_ops (
  idempotency_key TEXT PRIMARY KEY,
  action_id       INTEGER,
  enquiry_id      TEXT,
  type            TEXT NOT NULL,
  state           TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  external_ref    TEXT,
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ops_state ON external_ops(state);
`);

/**
 * Five states. UNKNOWN is the one that matters: it is a real outcome, not a
 * temporary label for "probably failed".
 *
 *   PENDING  -> IN_FLIGHT -> SUCCEEDED          request accepted, response received
 *                         -> FAILED_SAFE        rejected before commit, safe to retry
 *                         -> UNKNOWN            request sent, outcome never observed
 *   UNKNOWN  -> SUCCEEDED                       reconciliation found the commit
 *            -> FAILED_SAFE                     reconciliation proved nothing committed
 *            -> UNKNOWN                         reconciliation itself failed; stays unknown
 */
export const STATE = {
  PENDING: 'PENDING',
  IN_FLIGHT: 'IN_FLIGHT',
  SUCCEEDED: 'SUCCEEDED',
  FAILED_SAFE: 'FAILED_SAFE',
  UNKNOWN: 'UNKNOWN'
};

/**
 * Stable across retries because it is derived only from what the action *is*,
 * never from a timestamp, random value or attempt number. Two attempts at the same
 * action produce the same key, which is what lets the external service dedupe.
 */
export function idempotencyKey({ enquiryId, type, payload }) {
  const canonical = JSON.stringify(payload, Object.keys(payload ?? {}).sort());
  return crypto.createHash('sha256')
    .update(`${enquiryId}|${type}|${canonical}`)
    .digest('hex')
    .slice(0, 32);
}

const get = (key) => db.prepare('SELECT * FROM external_ops WHERE idempotency_key = ?').get(key);

function setState(key, state, patch = {}) {
  db.prepare(`UPDATE external_ops
              SET state = ?, external_ref = COALESCE(?, external_ref),
                  last_error = ?, attempts = attempts + ?, updated_at = ?
              WHERE idempotency_key = ?`)
    .run(state, patch.external_ref ?? null, patch.last_error ?? null,
         patch.countAttempt ? 1 : 0, now(), key);
  return get(key);
}

/**
 * The only way a consequential action reaches an external service.
 *
 * Every call is written to the ledger *before* the request leaves, so a process that
 * dies mid-request still leaves evidence that a request may have been sent.
 */
export async function performExternal({ enquiryId, actionId, type, payload }) {
  const key = idempotencyKey({ enquiryId, type, payload });
  let op = get(key);

  if (!op) {
    db.prepare(`INSERT INTO external_ops
      (idempotency_key, action_id, enquiry_id, type, state, attempts, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?)`)
      .run(key, actionId ?? null, enquiryId ?? null, type, STATE.PENDING, now(), now());
    op = get(key);
    audit(enquiryId, 'outbox', 'op_recorded', `${type} recorded as PENDING before the request was sent`, { key });
  }

  // Already done. A retry must not call the service again, even to "check".
  if (op.state === STATE.SUCCEEDED) {
    audit(enquiryId, 'outbox', 'retry_suppressed',
      `${type} already SUCCEEDED as ${op.external_ref}; retry did not call the service`, { key });
    return { state: STATE.SUCCEEDED, external_ref: op.external_ref, calledService: false, replayed: true };
  }

  // Outcome was never observed. Ask the service what happened before doing anything else.
  if (op.state === STATE.UNKNOWN || op.state === STATE.IN_FLIGHT) {
    audit(enquiryId, 'outbox', 'reconciling',
      `${type} is ${op.state}; querying the service by idempotency key instead of retrying blind`, { key });
    try {
      const found = await lookupByIdempotencyKey(key);
      if (found.found) {
        setState(key, STATE.SUCCEEDED, { external_ref: found.external_ref });
        audit(enquiryId, 'outbox', 'reconciled_succeeded',
          `the service had already committed ${found.external_ref}; no second request was sent`, { key });
        return { state: STATE.SUCCEEDED, external_ref: found.external_ref, calledService: false, reconciled: true };
      }
      setState(key, STATE.FAILED_SAFE, { last_error: 'reconciliation found no commit' });
      audit(enquiryId, 'outbox', 'reconciled_failed_safe',
        'the service holds nothing for this key, so nothing was committed and a retry is safe', { key });
      op = get(key);
    } catch (err) {
      setState(key, STATE.UNKNOWN, { last_error: `reconcile failed: ${err.message}` });
      audit(enquiryId, 'outbox', 'reconcile_failed',
        `could not determine the outcome; staying UNKNOWN rather than assuming either way: ${err.message}`, { key });
      return { state: STATE.UNKNOWN, external_ref: null, calledService: false, needsHuman: true };
    }
  }

  setState(key, STATE.IN_FLIGHT, { countAttempt: true });

  try {
    const res = await callExternal(type, payload, key);
    const final = setState(key, STATE.SUCCEEDED, { external_ref: res.external_ref });
    audit(enquiryId, 'outbox', 'succeeded',
      `${type} committed as ${res.external_ref}${res.replayed ? ' (service replayed an earlier commit)' : ''}`, { key });
    return { state: STATE.SUCCEEDED, external_ref: final.external_ref, calledService: true, replayed: res.replayed };
  } catch (err) {
    // The distinction the whole design rests on.
    if (err instanceof TransportTimeout && err.message.includes('before the request was accepted')) {
      setState(key, STATE.FAILED_SAFE, { last_error: err.message });
      audit(enquiryId, 'outbox', 'failed_safe',
        `${type} was rejected before commit, so nothing happened externally and a retry is safe: ${err.message}`, { key });
      return { state: STATE.FAILED_SAFE, external_ref: null, calledService: true, error: err.message };
    }

    setState(key, STATE.UNKNOWN, { last_error: err.message });
    audit(enquiryId, 'outbox', 'unknown_outcome',
      `${type} was sent but no response arrived. Recorded as UNKNOWN. It is not treated as success and not retried until reconciliation says it is safe: ${err.message}`,
      { key });
    return { state: STATE.UNKNOWN, external_ref: null, calledService: true, needsHuman: true, error: err.message };
  }
}

/** Anything a human needs to look at. UNKNOWN never resolves itself silently. */
export const unresolvedOps = () =>
  db.prepare(`SELECT * FROM external_ops WHERE state IN (?, ?) ORDER BY updated_at`)
    .all(STATE.UNKNOWN, STATE.IN_FLIGHT);

export const getOp = (key) => get(key);
