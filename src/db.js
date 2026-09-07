import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';


const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const dbPath = process.env.BEDA_DB || path.join(root, 'beda.db');
export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS enquiries (
  id            TEXT PRIMARY KEY,
  channel       TEXT NOT NULL,
  provenance    TEXT NOT NULL,
  from_name     TEXT,
  from_email    TEXT,
  from_email_norm TEXT,
  subject       TEXT,
  body          TEXT NOT NULL,
  attachments   TEXT NOT NULL DEFAULT '[]',
  content_hash  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'received',
  received_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS crm_records (
  id            TEXT PRIMARY KEY,
  company       TEXT,
  company_norm  TEXT,
  contact       TEXT,
  email         TEXT,
  email_norm    TEXT,
  phone         TEXT,
  phone_e164    TEXT,
  location      TEXT,
  stage         TEXT,
  product       TEXT,
  status        TEXT,
  parse_flags   TEXT NOT NULL DEFAULT '[]'
);

-- LLM output, kept separate from the enquiry so the raw text is never overwritten
CREATE TABLE IF NOT EXISTS extractions (
  enquiry_id    TEXT PRIMARY KEY REFERENCES enquiries(id),
  category      TEXT NOT NULL,
  fields        TEXT NOT NULL,   -- json: { name: { value, source_span, unverified? } }
  missing       TEXT NOT NULL,   -- json array of required fields not present
  notes         TEXT,
  model         TEXT NOT NULL,
  mode          TEXT NOT NULL,   -- live | fixture
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS matches (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  enquiry_id    TEXT REFERENCES enquiries(id),
  target_kind   TEXT NOT NULL,   -- crm_record | enquiry
  target_id     TEXT NOT NULL,
  method        TEXT NOT NULL,   -- exact_email | company_domain | fuzzy_name | content_hash
  confidence    TEXT NOT NULL,   -- high | medium | low
  decision      TEXT NOT NULL,   -- linked | suggest_merge | needs_review
  rationale     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS actions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  enquiry_id    TEXT NOT NULL REFERENCES enquiries(id),
  type          TEXT NOT NULL,
  policy_level  TEXT NOT NULL,   -- SAFE_AUTO | REQUIRES_APPROVAL | NEVER_AUTO
  state         TEXT NOT NULL,   -- executed | awaiting_approval | blocked | rejected
  payload       TEXT NOT NULL,
  assigned_to   TEXT,
  approval_token TEXT,
  approved_by   TEXT,
  created_at    TEXT NOT NULL,
  resolved_at   TEXT
);

-- append only: nothing in the app issues UPDATE or DELETE against this table
CREATE TABLE IF NOT EXISTS audit (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  enquiry_id    TEXT,
  stage         TEXT NOT NULL,
  event         TEXT NOT NULL,
  reason        TEXT,
  detail        TEXT,
  at            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_enq ON audit(enquiry_id);
CREATE INDEX IF NOT EXISTS idx_actions_enq ON actions(enquiry_id);
`);

export function reset() {
  db.exec(`DELETE FROM audit; DELETE FROM actions; DELETE FROM matches;
           DELETE FROM extractions; DELETE FROM crm_records; DELETE FROM enquiries;`);
}
