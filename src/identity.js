import { db } from './db.js';
import {
  audit, normEmail, emailDomain, isFreeMail, normCompany, trigramSimilarity, toE164AU
} from './normalise.js';

const record = (enquiryId, m) => {
  db.prepare(`INSERT INTO matches (enquiry_id, target_kind, target_id, method, confidence, decision, rationale)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(enquiryId, m.target_kind, m.target_id, m.method, m.confidence, m.decision, m.rationale);
  audit(enquiryId, 'identity', m.decision, m.rationale, m);
};

/**
 * Matching runs cheapest-and-most-certain first. Nothing here merges anything:
 * the strongest outcome this code can produce is a suggestion for a human.
 */
export function resolveIdentity(enquiry, fields) {
  const results = [];
  const crm = db.prepare('SELECT * FROM crm_records').all();

  const enqEmail = normEmail(enquiry.from_email) || normEmail(fields.contact_email?.value);
  const domain = emailDomain(enqEmail);

  // 1. exact normalised email
  if (enqEmail) {
    for (const r of crm) {
      if (r.email_norm && r.email_norm === enqEmail) {
        results.push({ target_kind: 'crm_record', target_id: r.id, method: 'exact_email',
          confidence: 'high', decision: 'linked',
          rationale: `normalised sender address matches ${r.id} exactly` });
      }
    }
  }

  // 2. company domain, ignoring free-mail providers so unrelated senders never merge
  if (!results.length && domain && !isFreeMail(domain)) {
    for (const r of crm) {
      if (r.email_norm && r.email_norm.endsWith(`@${domain}`)) {
        results.push({ target_kind: 'crm_record', target_id: r.id, method: 'company_domain',
          confidence: 'medium', decision: 'linked',
          rationale: `sender domain ${domain} matches the address on ${r.id}` });
      }
    }
  }

  // 3. fuzzy company name, suggestion only
  const stated = normCompany(fields.company?.value);
  if (!results.length && stated) {
    for (const r of crm) {
      const score = trigramSimilarity(stated, r.company_norm || '');
      if (score >= 0.6) {
        results.push({ target_kind: 'crm_record', target_id: r.id, method: 'fuzzy_name',
          confidence: score >= 0.8 ? 'medium' : 'low', decision: 'needs_review',
          rationale: `company name similarity ${score.toFixed(2)} against ${r.id}; too weak to link automatically` });
      }
    }
  }

  // 4. contact name only, when there is no address at all
  const contact = (fields.contact_name?.value || enquiry.from_name || '').trim().toLowerCase();
  if (!results.length && contact.length > 2) {
    for (const r of crm) {
      if ((r.contact || '').trim().toLowerCase() === contact) {
        results.push({ target_kind: 'crm_record', target_id: r.id, method: 'contact_name',
          confidence: 'low', decision: 'needs_review',
          rationale: `contact name matches ${r.id} but no email address was supplied to confirm it` });
      }
    }
  }

  for (const m of results) record(enquiry.id, m);

  if (!results.length) {
    audit(enquiry.id, 'identity', 'no_match',
      'no CRM record matched on address, domain, company name or contact name');
  }

  // More than one CRM record matched: that is a duplicate in the CRM, not a decision to make here.
  if (results.filter((r) => r.decision === 'linked').length > 1) {
    const ids = results.filter((r) => r.decision === 'linked').map((r) => r.target_id);
    record(enquiry.id, {
      target_kind: 'crm_record', target_id: ids.join('+'), method: 'multi_match',
      confidence: 'high', decision: 'suggest_merge',
      rationale: `${ids.join(' and ')} appear to be the same organisation; merge is irreversible so it is left to a human`
    });
  }

  return results;
}

/**
 * Duplicates that already exist inside the CRM, independent of any enquiry.
 * C001 and C002 are the same organisation under two spellings and two addresses.
 * The system reports the pair and stops: merging is irreversible.
 */
export function detectCrmDuplicates() {
  const crm = db.prepare('SELECT * FROM crm_records').all();
  const found = [];

  for (let i = 0; i < crm.length; i++) {
    for (let j = i + 1; j < crm.length; j++) {
      const a = crm[i], b = crm[j];
      const domA = emailDomain(a.email), domB = emailDomain(b.email);
      const sameDomain = domA && domB && domA === domB && !isFreeMail(domA);
      const sameContact = a.contact && b.contact &&
        a.contact.trim().toLowerCase() === b.contact.trim().toLowerCase();
      const nameScore = trigramSimilarity(a.company_norm || '', b.company_norm || '');

      const signals = [];
      if (sameDomain) signals.push(`shared email domain ${domA}`);
      if (sameContact) signals.push(`same contact name "${a.contact}"`);
      if (nameScore >= 0.6) signals.push(`company name similarity ${nameScore.toFixed(2)}`);

      if (signals.length >= 2) {
        const m = {
          target_kind: 'crm_pair', target_id: `${a.id}+${b.id}`, method: 'crm_dedupe',
          confidence: signals.length >= 3 ? 'high' : 'medium', decision: 'suggest_merge',
          rationale: `${a.id} ("${a.company}") and ${b.id} ("${b.company}") match on ${signals.join(', ')}. Flagged for a human; the system does not merge.`
        };
        found.push(m);
        db.prepare(`INSERT INTO matches (enquiry_id, target_kind, target_id, method, confidence, decision, rationale)
                    VALUES (NULL, ?, ?, ?, ?, ?, ?)`)
          .run(m.target_kind, m.target_id, m.method, m.confidence, m.decision, m.rationale);
        audit(null, 'identity', 'crm_duplicate_suggested', m.rationale, m);
      }
    }
  }
  return found;
}

/** Duplicate CRM pairs that involve a record this enquiry was linked to. */
export function duplicatePairsFor(crmIds) {
  if (!crmIds.length) return [];
  return db.prepare("SELECT * FROM matches WHERE target_kind='crm_pair'").all()
    .filter((m) => crmIds.some((id) => m.target_id.split('+').includes(id)));
}

/** Same message arriving twice, or the same request through a second channel. */
export function findRelatedEnquiries(enquiry, fields) {
  const others = db.prepare('SELECT * FROM enquiries WHERE id != ?').all(enquiry.id);
  const out = [];
  const domain = emailDomain(enquiry.from_email);

  for (const o of others) {
    if (o.content_hash === enquiry.content_hash) {
      out.push({ target_kind: 'enquiry', target_id: o.id, method: 'content_hash',
        confidence: 'high', decision: 'linked', rationale: 'identical message content; treated as a resend' });
      continue;
    }
    const oDomain = emailDomain(o.from_email);
    if (domain && oDomain && domain === oDomain && !isFreeMail(domain)) {
      out.push({ target_kind: 'enquiry', target_id: o.id, method: 'sender_domain',
        confidence: 'medium', decision: 'linked',
        rationale: `same organisation domain (${domain}); likely the same request through another channel` });
      continue;
    }
    const a = (enquiry.from_name || '').trim().toLowerCase();
    const b = (o.from_name || '').trim().toLowerCase();
    if (a && a === b && !enquiry.from_email && !o.from_email) {
      out.push({ target_kind: 'enquiry', target_id: o.id, method: 'contact_name_no_address',
        confidence: 'low', decision: 'needs_review',
        rationale: `both messages name "${enquiry.from_name}" but neither supplied an address to confirm they are the same person` });
    }
  }

  for (const m of out) record(enquiry.id, m);
  return out;
}

/**
 * When two linked enquiries give different values for the same field, both are kept.
 * The later message is treated as current and the earlier one as superseded, and the
 * conflict itself is recorded rather than being overwritten.
 */
export function reconcileConflicts(enquiry, fields, relatedIds) {
  const conflicts = [];
  if (!relatedIds.length) return conflicts;

  const rows = db.prepare(
    `SELECT e.id, e.received_at, x.fields FROM enquiries e
     JOIN extractions x ON x.enquiry_id = e.id
     WHERE e.id IN (${relatedIds.map(() => '?').join(',')})`
  ).all(...relatedIds);

  for (const row of rows) {
    const prior = JSON.parse(row.fields);
    for (const key of ['contact_phone', 'contact_email', 'company']) {
      const a = prior[key]?.value;
      const b = fields[key]?.value;
      if (!a || !b) continue;

      const same = key === 'contact_phone'
        ? (toE164AU(a) && toE164AU(a) === toE164AU(b))
        : String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

      if (!same) {
        const c = {
          field: key,
          superseded: { value: a, from: row.id },
          current: { value: b, from: enquiry.id },
          decision: 'later_message_treated_as_current_previous_value_retained'
        };
        conflicts.push(c);
        audit(enquiry.id, 'identity', 'field_conflict',
          `${key}: ${row.id} supplied "${a}", ${enquiry.id} supplied "${b}". Both retained; the later message is treated as current and the CRM update is left for approval.`,
          c);
      }
    }
  }
  return conflicts;
}
