import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TEST_DB = path.join(os.tmpdir(), `beda-test-${process.pid}.db`);
process.env.BEDA_DB = TEST_DB;
process.on('exit', () => {
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.unlinkSync(TEST_DB + suffix); } catch {}
  }
});

import { db, reset } from '../src/db.js';
import { performExternal, idempotencyKey, STATE, getOp, unresolvedOps } from '../src/outbox.js';
import {
  resetService, faults, committedCount, committedFor
} from '../src/external_service.js';


const OP = {
  enquiryId: 'E001',
  actionId: 1,
  type: 'send_reply',
  payload: { to: 'amelia.grant@humelogistics.example', draft: 'Hi Amelia, ...' }
};

function fresh() {
  reset();
  db.exec('DELETE FROM external_ops');
  resetService();
}

test('the idempotency key is derived from the action, so a retry produces the same key', () => {
  fresh();
  const a = idempotencyKey(OP);
  const b = idempotencyKey({ ...OP, actionId: 99 });          // attempt metadata must not matter
  const c = idempotencyKey({ ...OP, payload: { draft: 'Hi Amelia, ...', to: OP.payload.to } });
  assert.equal(a, b, 'key changed when only attempt metadata changed');
  assert.equal(a, c, 'key changed when only key order changed');

  const different = idempotencyKey({ ...OP, payload: { ...OP.payload, draft: 'different text' } });
  assert.notEqual(a, different, 'a different payload must not reuse the same key');
});

test('timeout after commit is recorded as UNKNOWN, not success and not failure', async () => {
  fresh();
  faults.timeoutAfterCommit = true;

  const res = await performExternal(OP);

  assert.equal(res.state, STATE.UNKNOWN);
  assert.equal(res.external_ref, null, 'no external reference may be invented for an unobserved outcome');
  assert.equal(res.needsHuman, true);

  const op = getOp(idempotencyKey(OP));
  assert.equal(op.state, STATE.UNKNOWN);
  assert.equal(op.attempts, 1);

  // The service really did commit; the caller simply never learned it.
  assert.equal(committedCount(), 1);

  const trail = db.prepare("SELECT event FROM audit WHERE enquiry_id='E001' AND stage='outbox'").all()
    .map((r) => r.event);
  assert.deepEqual(trail, ['op_recorded', 'unknown_outcome']);
  assert.equal(unresolvedOps().length, 1, 'an unknown outcome must stay visible for a human');
});

test('retrying after an unknown outcome reconciles instead of sending a second time', async () => {
  fresh();

  faults.timeoutAfterCommit = true;
  const first = await performExternal(OP);
  assert.equal(first.state, STATE.UNKNOWN);
  assert.equal(committedCount(), 1);

  // The network recovers and the same job runs again.
  faults.timeoutAfterCommit = false;
  const second = await performExternal(OP);

  assert.equal(second.state, STATE.SUCCEEDED);
  assert.equal(second.reconciled, true);
  assert.equal(second.calledService, false, 'reconciliation must not re-send the action');
  assert.equal(committedCount(), 1, 'the retry created a second external action');

  const op = getOp(idempotencyKey(OP));
  assert.equal(op.state, STATE.SUCCEEDED);
  assert.equal(op.external_ref, committedFor(idempotencyKey(OP)).external_ref,
    'the recovered reference must be the one the service actually committed');
  assert.equal(unresolvedOps().length, 0);
});

test('a second retry after success does not touch the service at all', async () => {
  fresh();
  await performExternal(OP);
  assert.equal(committedCount(), 1);

  const again = await performExternal(OP);
  assert.equal(again.state, STATE.SUCCEEDED);
  assert.equal(again.calledService, false);
  assert.equal(again.replayed, true);
  assert.equal(committedCount(), 1);
});

test('a failure before commit is FAILED_SAFE and the retry commits exactly once', async () => {
  fresh();
  faults.failBeforeCommit = true;

  const first = await performExternal(OP);
  assert.equal(first.state, STATE.FAILED_SAFE);
  assert.equal(committedCount(), 0, 'nothing may be committed when the request was rejected');

  faults.failBeforeCommit = false;
  const second = await performExternal(OP);
  assert.equal(second.state, STATE.SUCCEEDED);
  assert.equal(committedCount(), 1);
});

test('an unknown outcome stays unknown when reconciliation itself fails', async () => {
  fresh();
  faults.timeoutAfterCommit = true;
  await performExternal(OP);

  // The service is still unreachable when the retry runs, so the outcome cannot be checked.
  faults.lookupFails = true;
  const second = await performExternal(OP);

  assert.equal(second.state, STATE.UNKNOWN, 'an unreachable service must not downgrade UNKNOWN to failed');
  assert.equal(second.needsHuman, true);
  assert.equal(committedCount(), 1, 'still exactly one commit from the original attempt');
  assert.equal(unresolvedOps().length, 1);
});
