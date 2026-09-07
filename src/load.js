import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, reset } from './db.js';
import { audit, now, normEmail, normCompany, toE164AU, contentHash } from './normalise.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (f) => JSON.parse(fs.readFileSync(path.join(root, 'data', f), 'utf8'));

export const documents = read('documents.json');
export const staff = read('staff.json');

const CRM_COLUMNS = ['id', 'company', 'contact', 'email', 'phone', 'location', 'stage', 'product', 'status'];

/**
 * The seed CSV is not uniform: C002 has 8 fields because the phone column is absent.
 * Splitting positionally would shift location into phone and silently corrupt the record,
 * so short rows are realigned by detecting which field is missing and flagged for review
 * rather than being repaired quietly.
 */
function parseCrmRow(line) {
  const parts = line.split(',').map((s) => s.trim());
  const flags = [];
  let row;

  if (parts.length === CRM_COLUMNS.length) {
    row = Object.fromEntries(CRM_COLUMNS.map((c, i) => [c, parts[i]]));
  } else if (parts.length === CRM_COLUMNS.length - 1) {
    // one column short: assume the optional phone field, but only if position 4
    // does not look like a phone number.
    const looksLikePhone = /^[\d +()-]{8,}$/.test(parts[4] || '');
    if (looksLikePhone) throw new Error(`unexpected short row shape: ${line}`);
    const withPhone = [...parts.slice(0, 4), null, ...parts.slice(4)];
    row = Object.fromEntries(CRM_COLUMNS.map((c, i) => [c, withPhone[i]]));
    flags.push('phone_missing_in_source');
  } else {
    throw new Error(`unparseable CRM row: ${line}`);
  }
  return { row, flags };
}

export function loadAll({ fresh = true } = {}) {
  if (fresh) reset();

  const csv = fs.readFileSync(path.join(root, 'data', 'crm_seed.csv'), 'utf8')
    .split('\n').map((l) => l.trim()).filter(Boolean);

  const insCrm = db.prepare(`INSERT INTO crm_records
    (id, company, company_norm, contact, email, email_norm, phone, phone_e164, location, stage, product, status, parse_flags)
    VALUES (@id, @company, @company_norm, @contact, @email, @email_norm, @phone, @phone_e164, @location, @stage, @product, @status, @parse_flags)`);

  for (const line of csv) {
    const { row, flags } = parseCrmRow(line);
    insCrm.run({
      ...row,
      company_norm: normCompany(row.company),
      email_norm: normEmail(row.email),
      phone_e164: toE164AU(row.phone),
      parse_flags: JSON.stringify(flags)
    });
    if (flags.length) {
      audit(null, 'load', 'crm_row_flagged', `row ${row.id}: ${flags.join(', ')}`, { row });
    }
  }

  const insEnq = db.prepare(`INSERT INTO enquiries
    (id, channel, provenance, from_name, from_email, from_email_norm, subject, body, attachments, content_hash, status, received_at)
    VALUES (@id, @channel, @provenance, @from_name, @from_email, @from_email_norm, @subject, @body, @attachments, @content_hash, 'received', @received_at)`);

  const enquiries = read('enquiries.json');
  for (const e of enquiries) {
    insEnq.run({
      id: e.id,
      channel: e.channel,
      provenance: e.provenance,
      from_name: e.from_name,
      from_email: e.from_email,
      from_email_norm: normEmail(e.from_email),
      subject: e.subject,
      body: e.body,
      attachments: JSON.stringify(e.attachments || []),
      content_hash: contentHash(e),
      received_at: now()
    });
    audit(e.id, 'load', 'ingested', `channel=${e.channel}, provenance=${e.provenance}`);

    for (const a of e.attachments || []) {
      const doc = documents.find((d) => d.filename === a);
      if (!doc || !doc.supplied) {
        audit(e.id, 'load', 'attachment_referenced_not_supplied', `${a} is referenced by the message but was not in the data pack`);
      } else {
        audit(e.id, 'load', 'attachment_loaded', a);
      }
    }
  }

  return { crm: csv.length, enquiries: enquiries.length };
}

export const getDocument = (filename) => documents.find((d) => d.filename === filename) || null;
