import { audit } from './normalise.js';
import { staff } from './load.js';

const owner = (topic) => staff.find((s) => s.owns.includes(topic))?.name ?? null;

/** Signals that make an opportunity large enough for the founder to own it. */
function isMajorOpportunity(fields) {
  const c = String(fields.annual_consumption?.value ?? '');
  const s = String(fields.monthly_spend?.value ?? '');
  if (/gwh/i.test(c)) return true;
  if (/gigawatt/i.test(c)) return true;
  const monthly = Number(s.replace(/[^\d.]/g, ''));
  return Number.isFinite(monthly) && monthly >= 10000;
}

/**
 * Routing is entirely deterministic. The model supplied the category and the fields;
 * what happens as a result is decided here, from validated values only.
 */
export function route(enquiry, extraction, ctx) {
  const f = extraction.fields;
  const missing = extraction.missing || [];
  let assigned = null, priority = 'normal', nextAction = null, reason = '';

  switch (extraction.category) {
    case 'sales_opportunity': {
      const major = isMajorOpportunity(f);
      const blocked = !!f.blocker?.value;
      const noIdentity = !enquiry.from_email && !f.company?.value;

      if (noIdentity) {
        assigned = owner('inbound_growth');
        priority = major ? 'high' : 'low';
        nextAction = 'request_missing_information';
        reason = 'No company name or email address was supplied, so no CRM record can be created with confidence.';
      } else if (blocked) {
        assigned = owner('inbound_growth');
        priority = 'low';
        nextAction = 'draft_reply_low_priority';
        reason = `Qualification blocker stated by the sender: ${f.blocker.value}.`;
      } else if (major) {
        assigned = owner('major_commercial_opportunity');
        priority = 'high';
        nextAction = missing.length ? 'draft_reply_and_request_information' : 'draft_reply_and_propose_meeting';
        reason = 'Consumption or spend is above the threshold for a major commercial opportunity.';
      } else {
        assigned = owner('inbound_growth');
        nextAction = missing.length ? 'draft_reply_and_request_information' : 'draft_reply';
        reason = 'Standard inbound opportunity.';
      }
      break;
    }

    case 'support_request':
      assigned = owner('general_operations');
      priority = f.deadline?.value ? 'high' : 'normal';
      nextAction = 'draft_reply_and_open_ticket';
      reason = 'Existing client with a service issue rather than a new opportunity.';
      break;

    case 'partner_operations':
      assigned = owner('scheduling');
      priority = 'high';
      nextAction = 'draft_reply_pending_resource_check';
      reason = 'Partner is asking BEDA to commit resource, which is a promise the system will not make on its own.';
      break;

    case 'internal_incident':
      assigned = owner('systems');
      priority = 'high';
      nextAction = 'open_internal_incident';
      reason = 'Internal systems failure. Not a customer enquiry and no external reply is appropriate.';
      break;

    case 'technical_question':
      assigned = null;
      priority = 'normal';
      nextAction = 'escalate_no_owner';
      reason = 'The staff directory contains no engineering role able to answer this. Assigning it to the closest-sounding person would be a guess.';
      break;

    case 'recruitment':
      assigned = null;
      priority = 'low';
      nextAction = 'escalate_no_owner';
      reason = 'No recruitment owner in the directory. Administration and marketing are both plausible, so the choice is left to a human.';
      break;

    case 'junk':
      assigned = null;
      priority = 'low';
      nextAction = 'archive_with_reason';
      reason = 'Unsolicited commercial message. Archived with its classification so it stays auditable rather than deleted.';
      break;

    default:
      assigned = null;
      priority = 'low';
      nextAction = 'human_review';
      reason = 'Not enough information to classify or act on.';
  }

  if (ctx?.suggestMerge?.length) {
    reason += ` Possible duplicate CRM records flagged: ${ctx.suggestMerge.join(', ')}.`;
  }
  if (ctx?.conflicts?.length) {
    reason += ` ${ctx.conflicts.length} field conflict(s) preserved for review.`;
  }

  const decision = { assigned_to: assigned, priority, next_action: nextAction, reason };
  audit(enquiry.id, 'routing', 'routed',
    `${extraction.category} -> ${assigned ?? 'UNASSIGNED'} (${priority}). ${reason}`, decision);
  return decision;
}

/**
 * Filenames from the data pack are internal references. They belong in the reviewer's
 * missing list and the audit trail, but a customer has no idea what they are, so they
 * are filtered out of anything the customer would read.
 */
const isInternalReference = (m) => /\.[a-z0-9]{2,4}$/i.test(m);

const listMissing = (missing) =>
  missing
    .filter((m) => !isInternalReference(m))
    .map((m) => `- ${m.replace(/_/g, ' ')}`)
    .join('\n');

/**
 * Drafts are assembled from verified fields only. Nothing about price, scope, timeline
 * or availability is stated, because none of that is knowable from the enquiry.
 */
export function draftReply(enquiry, extraction, decision, extras = {}) {
  const f = extraction.fields;
  const who = f.contact_name?.value || enquiry.from_name || 'there';
  const missing = extraction.missing || [];

  if (['archive_with_reason', 'open_internal_incident'].includes(decision.next_action)) return null;

  const head = `Hi ${who},\n\nThanks for getting in touch with BEDA.`;
  const sign = `\n\nKind regards,\n${decision.assigned_to ?? '[unassigned — needs an owner before sending]'}\nBEDA`;

  switch (extraction.category) {
    case 'sales_opportunity': {
      const noted = [
        f.sites?.value && `your sites (${f.sites.value})`,
        f.annual_consumption?.value && `annual consumption of ${f.annual_consumption.value}`,
        f.monthly_spend?.value && `electricity spend of ${f.monthly_spend.value}`,
        f.product_interest?.value && `interest in ${f.product_interest.value}`
      ].filter(Boolean);

      let body = `${head}\n\nI have noted ${noted.join(', ')}.`;
      if (f.blocker?.value) {
        body += `\n\nYou mentioned that ${f.blocker.value}. That usually needs to be resolved before a rooftop system can be assessed, so it would help to know where that stands.`;
      }
      const askable = listMissing(missing);
      if (askable) {
        body += `\n\nBefore we can put anything useful together, could you send:\n${askable}`;
      }
      if (decision.next_action === 'draft_reply_and_propose_meeting') {
        body += `\n\nHappy to arrange an initial discussion — let me know a time that suits.`;
      }
      return body + sign;
    }

    case 'support_request': {
      let body = `${head}\n\nThanks for flagging this.`;
      if (f.reference_number?.value) body += ` I have logged your query about ${f.reference_number.value}`;
      if (f.amount_disputed?.value) body += ` and the ${f.amount_disputed.value} difference against the purchase order`;
      body += '.';
      if (extras.reconciliation?.matches_claim) {
        body += `\n\nOur records show a purchase order of $${extras.reconciliation.po.toLocaleString()} and an invoice of $${extras.reconciliation.invoice.toLocaleString()}, so the difference you have identified is correct. I am having it reviewed before payment is due.`;
      }
      if (f.deadline?.value) body += `\n\nI will come back to you ${f.deadline.value}.`;
      return body + sign;
    }

    case 'partner_operations':
      return `${head}\n\nThanks for the details on the ${f.location?.value ?? ''} project${f.timeline?.value ? ` for the ${f.timeline.value}` : ''}.\n\nI am checking crew availability now and will confirm${f.deadline?.value ? ` by ${f.deadline.value}` : ''}.\n\n[This draft deliberately stops short of confirming the crew. Availability has not been checked by the system and committing resource is not something it will do.]${sign}`;

    case 'recruitment':
      return `${head}\n\nThanks for your interest in working with BEDA. Your application has been passed to the right person and you will hear back from us.${sign}`;

    case 'technical_question':
      return `${head}\n\nThanks for the question on the battery inverter specification. This needs an electrical engineer to answer properly, so I am passing it on rather than giving you a partial answer.\n\n[No engineering role exists in the supplied staff directory. This draft cannot be sent until an owner is assigned.]${sign}`;

    default:
      return null;
  }
}
