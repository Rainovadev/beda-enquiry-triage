import crypto from 'node:crypto';
import { db } from './db.js';
import { audit, now } from './normalise.js';
import { performExternal, STATE } from './outbox.js';

/**
 * The only place in the system that decides what may run unattended.
 * Anything not listed here throws, so adding a capability forces a decision about its risk.
 */
export const POLICY = {
  log_enquiry:           'SAFE_AUTO',
  classify_enquiry:      'SAFE_AUTO',
  draft_reply:           'SAFE_AUTO',          // drafting is not sending
  notify_internal:       'SAFE_AUTO',
  archive_junk:          'SAFE_AUTO',          // archived with reason, recoverable
  open_internal_incident:'SAFE_AUTO',

  create_crm_record:     'REQUIRES_APPROVAL',
  update_crm_record:     'REQUIRES_APPROVAL',
  send_reply:            'REQUIRES_APPROVAL',
  request_information:   'REQUIRES_APPROVAL',  // still an outbound email

  confirm_resource:      'NEVER_AUTO',         // committing crew, dates or scope
  send_quote:            'NEVER_AUTO',
  merge_crm_record:      'NEVER_AUTO',
  delete_crm_record:     'NEVER_AUTO'
};

const EXECUTORS = {
  log_enquiry:            (p) => ({ logged: p.enquiry_id }),
  classify_enquiry:       (p) => ({ category: p.category }),
  draft_reply:            (p) => ({ chars: (p.draft || '').length }),
  notify_internal:        (p) => ({ notified: p.assigned_to }),
  archive_junk:           (p) => ({ archived: p.enquiry_id, reason: p.reason }),
  open_internal_incident: (p) => ({ incident: p.enquiry_id, assigned_to: p.assigned_to })
};

/**
 * Actions that leave the system. These do not run inline: they go through the outbox,
 * which records the attempt before the request is sent and can tell the difference
 * between "failed" and "we do not know".
 */
export const EXTERNAL_ACTIONS = new Set([
  'create_crm_record', 'update_crm_record', 'send_reply', 'request_information'
]);

/**
 * Every action in the system goes through here. There is no other path to an executor,
 * so text arriving from a sender cannot reach one even if it is written as an instruction.
 */
export function dispatch(action, payload, ctx = {}) {
  const level = POLICY[action];
  if (!level) throw new Error(`unregistered action: ${action}`);

  const insert = db.prepare(`INSERT INTO actions
    (enquiry_id, type, policy_level, state, payload, assigned_to, approval_token, approved_by, created_at, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  if (level === 'NEVER_AUTO') {
    const id = insert.run(ctx.enquiryId, action, level, 'blocked', JSON.stringify(payload),
      ctx.assignedTo ?? null, null, null, now(), null).lastInsertRowid;
    audit(ctx.enquiryId, 'action_gate', 'blocked_never_auto',
      ctx.reason || `${action} is never performed automatically; it is handed to a human`, { action_id: id });
    return { id, state: 'blocked', level };
  }

  if (level === 'REQUIRES_APPROVAL') {
    const token = crypto.randomBytes(12).toString('hex');
    const id = insert.run(ctx.enquiryId, action, level, 'awaiting_approval', JSON.stringify(payload),
      ctx.assignedTo ?? null, token, null, now(), null).lastInsertRowid;
    audit(ctx.enquiryId, 'action_gate', 'awaiting_approval',
      ctx.reason || `${action} prepared but held for approval by ${ctx.assignedTo ?? 'an unassigned owner'}`,
      { action_id: id });
    return { id, state: 'awaiting_approval', level, token };
  }

  const result = EXECUTORS[action](payload);
  const id = insert.run(ctx.enquiryId, action, level, 'executed', JSON.stringify(payload),
    ctx.assignedTo ?? null, null, 'system', now(), now()).lastInsertRowid;
  audit(ctx.enquiryId, 'action_gate', 'executed', ctx.reason || `${action} is safe to run unattended`,
    { action_id: id, result });
  return { id, state: 'executed', level, result };
}

/**
 * Approval is verified against the stored token; it is not taken from the request body.
 *
 * The token is only cleared once the outcome is known to be SUCCEEDED. An action whose
 * outcome is UNKNOWN stays in the queue with its token intact, so the same approval can
 * be resolved later without a human approving the same thing twice.
 */
export async function approve(actionId, token, approver) {
  const row = db.prepare('SELECT * FROM actions WHERE id = ?').get(actionId);
  if (!row) throw new Error('unknown action');
  if (row.state !== 'awaiting_approval' && row.state !== 'unknown_outcome') {
    throw new Error(`action is ${row.state}, not awaiting approval`);
  }
  if (row.policy_level === 'NEVER_AUTO') throw new Error('this action is never executed by the system');
  if (!token || token !== row.approval_token) {
    audit(row.enquiry_id, 'action_gate', 'approval_rejected', `invalid token supplied for action ${actionId}`);
    throw new Error('invalid approval token');
  }

  const payload = JSON.parse(row.payload);

  if (EXTERNAL_ACTIONS.has(row.type)) {
    const res = await performExternal({
      enquiryId: row.enquiry_id, actionId, type: row.type, payload
    });

    if (res.state === STATE.SUCCEEDED) {
      db.prepare(`UPDATE actions SET state='executed', approved_by=?, approval_token=NULL, resolved_at=? WHERE id=?`)
        .run(approver, now(), actionId);
      audit(row.enquiry_id, 'action_gate', 'executed_after_approval',
        `${row.type} approved by ${approver} and confirmed as ${res.external_ref}`, { action_id: actionId });
      return { id: actionId, state: 'executed', external_ref: res.external_ref, result: res };
    }

    if (res.state === STATE.UNKNOWN) {
      // Deliberately not 'executed' and not 'failed'. The token survives so the same
      // approval can be resolved on a later attempt.
      db.prepare(`UPDATE actions SET state='unknown_outcome', approved_by=? WHERE id=?`)
        .run(approver, actionId);
      audit(row.enquiry_id, 'action_gate', 'unknown_outcome',
        `${row.type} was sent but the outcome was never observed. Held as unknown_outcome for reconciliation; not recorded as sent, not retried blind.`,
        { action_id: actionId });
      return { id: actionId, state: 'unknown_outcome', needsHuman: true, result: res };
    }

    // FAILED_SAFE: nothing committed externally, so the action returns to the queue.
    db.prepare(`UPDATE actions SET state='awaiting_approval', approved_by=NULL WHERE id=?`).run(actionId);
    audit(row.enquiry_id, 'action_gate', 'failed_safe',
      `${row.type} did not reach the service. Nothing was committed, so it is safe to try again.`,
      { action_id: actionId });
    return { id: actionId, state: 'failed_safe', result: res };
  }

  const result = EXECUTORS[row.type](payload);
  db.prepare(`UPDATE actions SET state='executed', approved_by=?, approval_token=NULL, resolved_at=? WHERE id=?`)
    .run(approver, now(), actionId);
  audit(row.enquiry_id, 'action_gate', 'executed_after_approval',
    `${row.type} approved by ${approver}`, { action_id: actionId, result });
  return { id: actionId, state: 'executed', result };
}

export function reject(actionId, approver, reason) {
  const row = db.prepare('SELECT * FROM actions WHERE id = ?').get(actionId);
  if (!row) throw new Error('unknown action');
  db.prepare(`UPDATE actions SET state='rejected', approved_by=?, approval_token=NULL, resolved_at=? WHERE id=?`)
    .run(approver, now(), actionId);
  audit(row.enquiry_id, 'action_gate', 'rejected', `${row.type} rejected by ${approver}: ${reason || 'no reason given'}`);
  return { id: actionId, state: 'rejected' };
}
