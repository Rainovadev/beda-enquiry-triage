import crypto from 'node:crypto';
import { db } from './db.js';

export const now = () => new Date().toISOString();

export function audit(enquiryId, stage, event, reason = null, detail = null) {
  db.prepare(
    `INSERT INTO audit (enquiry_id, stage, event, reason, detail, at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(enquiryId, stage, event, reason, detail ? JSON.stringify(detail) : null, now());
}

/** Lowercase, strip +tags, drop dots for gmail-style providers. */
export function normEmail(email) {
  if (!email) return null;
  const [localRaw, domainRaw] = String(email).trim().toLowerCase().split('@');
  if (!domainRaw) return null;
  let local = localRaw.split('+')[0];
  if (['gmail.com', 'googlemail.com'].includes(domainRaw)) local = local.replace(/\./g, '');
  return `${local}@${domainRaw}`;
}

export function emailDomain(email) {
  const n = normEmail(email);
  return n ? n.split('@')[1] : null;
}

const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
  'icloud.com', 'proton.me', 'examplemail.test'
]);
export const isFreeMail = (domain) => !!domain && FREE_MAIL.has(domain);

/**
 * Australian mobile/landline to E.164. Returns null rather than guessing
 * when the input does not look like a complete AU number.
 */
export function toE164AU(phone) {
  if (!phone) return null;
  const d = String(phone).replace(/[^\d+]/g, '');
  if (d.startsWith('+61')) return d;
  if (d.startsWith('61') && d.length === 11) return `+${d}`;
  if (d.startsWith('0') && d.length === 10) return `+61${d.slice(1)}`;
  return null;
}

/** Company name normalisation for fuzzy matching only. Never overwrites the stored name. */
export function normCompany(name) {
  if (!name) return null;
  return String(name)
    .toLowerCase()
    .replace(/\b(pty|ltd|limited|inc|llc|co|group|holdings)\b/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Character-trigram Dice coefficient. Small, dependency-free, good enough for company names. */
export function trigramSimilarity(a, b) {
  const grams = (s) => {
    const p = `  ${s} `;
    const out = new Set();
    for (let i = 0; i < p.length - 2; i++) out.add(p.slice(i, i + 3));
    return out;
  };
  if (!a || !b) return 0;
  const A = grams(a), B = grams(b);
  let shared = 0;
  for (const g of A) if (B.has(g)) shared++;
  return (2 * shared) / (A.size + B.size);
}

/** Identifies a resent/duplicate message before any model is called. */
export function contentHash({ from_email, subject, body }) {
  const basis = [normEmail(from_email) || '', (subject || '').trim().toLowerCase(), (body || '').trim()].join('|');
  return crypto.createHash('sha256').update(basis).digest('hex').slice(0, 16);
}

/** Collapses whitespace so a source span written with different spacing still matches. */
export const flatten = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
