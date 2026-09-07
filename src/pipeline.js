import { db } from './db.js';
import { audit, now } from './normalise.js';
import { loadAll, getDocument } from './load.js';
import { classify } from './classify.js';
import { verifyExtraction, reconcileInvoice } from './verify.js';
import { resolveIdentity, findRelatedEnquiries, reconcileConflicts, detectCrmDuplicates, duplicatePairsFor } from './identity.js';
import { route, draftReply } from './routing.js';
import { dispatch } from './actions.js';

const SPAM_SIGNALS = [
  /cryptocurrency payment/i,
  /price expires in \d+ hours/i,
  /\bbuy \d{3,},?\d*\s+(leads|emails|contacts)/i
];

/** Cheap deterministic checks that run before any model is called. */
function preCheck(e) {
  const text = `${e.subject || ''} ${e.body}`;
  const hits = SPAM_SIGNALS.filter((r) => r.test(text)).map((r) => r.source);

  const dupe = db.prepare(
    'SELECT id FROM enquiries WHERE content_hash = ? AND id != ? AND received_at <= ?'
  ).get(e.content_hash, e.id, e.received_at);

  if (dupe) {
    audit(e.id, 'pre_check', 'resend_detected', `identical content to ${dupe.id}; not processed as a new enquiry`);
    return { skip: true, reason: 'resend' };
  }
  if (hits.length) {
    audit(e.id, 'pre_check', 'spam_signals', `matched ${hits.length} rule(s) before any model call`, { hits });
  }
  return { skip: false, spamSignals: hits };
}

export async function processOne(e) {
  const pre = preCheck(e);
  if (pre.skip) {
    db.prepare("UPDATE enquiries SET status='duplicate_resend' WHERE id=?").run(e.id);
    return;
  }

  const raw = await classify(e);
  const extraction = verifyExtraction(e, raw);

  // Attachments that were referenced but never supplied are surfaced, not guessed at.
  // This runs before the row is written so the reviewer's missing list includes them.
  const attachments = JSON.parse(e.attachments);
  let reconciliation = null;
  for (const a of attachments) {
    const doc = getDocument(a);
    if (!doc?.supplied) {
      if (!extraction.missing.includes(a)) extraction.missing.push(a);
      continue;
    }
    if (extraction.category === 'support_request') reconciliation = reconcileInvoice(e, doc);
  }

  db.prepare(`INSERT OR REPLACE INTO extractions
    (enquiry_id, category, fields, missing, notes, model, mode, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(e.id, extraction.category, JSON.stringify(extraction.fields),
      JSON.stringify(extraction.missing), extraction.notes, raw.model, raw.mode, now());

  const crmMatches = resolveIdentity(e, extraction.fields);
  const related = findRelatedEnquiries(e, extraction.fields);
  const conflicts = reconcileConflicts(e, extraction.fields, related.map((r) => r.target_id));

  const dupePairs = duplicatePairsFor(crmMatches.map((m) => m.target_id));
  const decision = route(e, extraction, {
    suggestMerge: [
      ...crmMatches.filter((m) => m.decision === 'suggest_merge').map((m) => m.target_id),
      ...dupePairs.map((m) => m.target_id)
    ],
    conflicts
  });

  const draft = draftReply(e, extraction, decision, { reconciliation });
  const ctx = { enquiryId: e.id, assignedTo: decision.assigned_to };

  // --- actions ---------------------------------------------------------
  if (extraction.category === 'junk') {
    dispatch('archive_junk', { enquiry_id: e.id, reason: extraction.notes }, { ...ctx, reason: decision.reason });
    db.prepare("UPDATE enquiries SET status='archived' WHERE id=?").run(e.id);
    return;
  }

  if (extraction.category === 'internal_incident') {
    dispatch('open_internal_incident', { enquiry_id: e.id, assigned_to: decision.assigned_to },
      { ...ctx, reason: decision.reason });
    dispatch('notify_internal', { assigned_to: decision.assigned_to, priority: decision.priority }, ctx);
    db.prepare("UPDATE enquiries SET status='incident_open' WHERE id=?").run(e.id);
    return;
  }

  if (draft) dispatch('draft_reply', { enquiry_id: e.id, draft }, ctx);
  if (decision.assigned_to) {
    dispatch('notify_internal', { assigned_to: decision.assigned_to, priority: decision.priority }, ctx);
  } else {
    audit(e.id, 'routing', 'no_owner_in_directory',
      'No role in the supplied staff directory owns this. Escalated rather than assigned to the closest-sounding person.');
  }

  // A commitment on BEDA's behalf is never executed, approved or not.
  if (decision.next_action === 'draft_reply_pending_resource_check') {
    dispatch('confirm_resource', { enquiry_id: e.id, request: extraction.fields },
      { ...ctx, reason: 'Confirming a crew commits BEDA to resource it has not verified. Handed to a human in full.' });
  }

  // CRM write: create or update, both held for approval.
  const linked = crmMatches.filter((m) => m.decision === 'linked');
  if (extraction.category === 'sales_opportunity' || extraction.category === 'support_request') {
    if (linked.length === 1 && dupePairs.length) {
      audit(e.id, 'crm', 'write_held',
        `${linked[0].target_id} belongs to a suspected duplicate pair (${dupePairs.map((d) => d.target_id).join(', ')}). Writing now would deepen the duplicate, so the merge decision comes first.`);
    } else if (linked.length === 1) {
      dispatch('update_crm_record',
        { crm_id: linked[0].target_id, fields: extraction.fields, conflicts },
        { ...ctx, reason: `Matched ${linked[0].target_id} by ${linked[0].method}. The write itself is held for approval.` });
    } else if (linked.length > 1) {
      audit(e.id, 'crm', 'write_held',
        `${linked.length} CRM records matched. Writing to either could deepen an existing duplicate, so a human resolves it first.`);
    } else if (extraction.fields.company?.value || e.from_email) {
      dispatch('create_crm_record', { fields: extraction.fields },
        { ...ctx, reason: 'No existing record matched. Creation is held for approval.' });
    } else {
      audit(e.id, 'crm', 'write_held',
        'No company name or email address supplied, so a new record would be unidentifiable. Held for a human.');
    }
  }

  if (draft) {
    const action = decision.next_action === 'request_missing_information' ? 'request_information' : 'send_reply';
    dispatch(action, { enquiry_id: e.id, to: e.from_email, draft },
      { ...ctx, reason: 'Outbound message to a customer. Never sent without approval.' });
  }

  db.prepare("UPDATE enquiries SET status='processed' WHERE id=?").run(e.id);
}

export async function runAll({ fresh = true } = {}) {
  const counts = loadAll({ fresh });
  detectCrmDuplicates();
  const rows = db.prepare('SELECT * FROM enquiries ORDER BY id').all();
  for (const e of rows) {
    try {
      await processOne(e);
    } catch (err) {
      audit(e.id, 'pipeline', 'stage_failed', err.message);
      db.prepare("UPDATE enquiries SET status='failed' WHERE id=?").run(e.id);
    }
  }
  return counts;
}
