import { audit, flatten } from './normalise.js';

/**
 * Every extracted field must carry the span of text it came from, and that span must
 * exist in what the sender actually supplied. A field whose span cannot be found is
 * dropped rather than trusted. This replaces a self-reported confidence score with a
 * check the code can actually perform.
 */
export function verifyExtraction(enquiry, extraction) {
  const supplied = flatten([
    enquiry.from_name, enquiry.from_email, enquiry.subject, enquiry.body
  ].filter(Boolean).join(' \n '));

  const fields = {};
  const dropped = [];

  for (const [name, f] of Object.entries(extraction.fields || {})) {
    if (!f || f.value === null || f.value === undefined) continue;

    if (!f.source_span || !supplied.includes(flatten(f.source_span))) {
      dropped.push(name);
      fields[name] = { value: null, source_span: f.source_span ?? null, unverified: true };
      continue;
    }
    fields[name] = { value: f.value, source_span: f.source_span };
  }

  if (dropped.length) {
    audit(enquiry.id, 'verify', 'fields_dropped',
      `source span not found in the supplied message: ${dropped.join(', ')}`, { dropped });
  } else {
    audit(enquiry.id, 'verify', 'all_fields_verified', `${Object.keys(fields).length} field(s) traced to source text`);
  }

  return { ...extraction, fields, dropped };
}

/**
 * Deterministic arithmetic check against a supplied document. The customer's claim is
 * confirmed by code, not by a model, because the answer is checkable.
 */
export function reconcileInvoice(enquiry, doc) {
  if (!doc?.supplied || !doc.body) return null;
  const nums = [...doc.body.matchAll(/\$([\d,]+(?:\.\d+)?)/g)].map((m) => Number(m[1].replace(/,/g, '')));
  if (nums.length < 2) return null;

  const [po, invoice] = nums;
  const variance = Number((invoice - po).toFixed(2));
  const claimed = enquiry.body.match(/\$([\d,]+(?:\.\d+)?)/);
  const claimedAmount = claimed ? Number(claimed[1].replace(/,/g, '')) : null;
  const matchesClaim = claimedAmount !== null && Math.abs(claimedAmount - variance) < 0.01;

  const result = { po, invoice, variance, claimed: claimedAmount, matches_claim: matchesClaim };
  audit(enquiry.id, 'verify', 'invoice_reconciled',
    matchesClaim
      ? `variance of $${variance} confirmed by arithmetic and matches the amount stated by the sender`
      : `variance of $${variance} does not match the amount stated by the sender`,
    result);
  return result;
}
