import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import { runAll } from './pipeline.js';
import { approve, reject, POLICY } from './actions.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const app = express();
app.use(express.json());
app.use(express.static(path.join(root, 'public')));

const parse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

app.get('/api/enquiries', (_req, res) => {
  const rows = db.prepare(`
    SELECT e.id, e.channel, e.provenance, e.from_email, e.subject, e.status,
           x.category, x.notes,
           (SELECT count(*) FROM actions a WHERE a.enquiry_id=e.id AND a.state='awaiting_approval') AS pending,
           (SELECT count(*) FROM actions a WHERE a.enquiry_id=e.id AND a.state='blocked') AS blocked
    FROM enquiries e LEFT JOIN extractions x ON x.enquiry_id=e.id ORDER BY e.id`).all();
  res.json(rows);
});

app.get('/api/enquiries/:id', (req, res) => {
  const e = db.prepare('SELECT * FROM enquiries WHERE id=?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'not found' });
  const x = db.prepare('SELECT * FROM extractions WHERE enquiry_id=?').get(req.params.id);
  res.json({
    enquiry: { ...e, attachments: parse(e.attachments, []) },
    extraction: x ? { ...x, fields: parse(x.fields, {}), missing: parse(x.missing, []) } : null,
    matches: db.prepare('SELECT * FROM matches WHERE enquiry_id=?').all(req.params.id),
    actions: db.prepare('SELECT * FROM actions WHERE enquiry_id=? ORDER BY id').all(req.params.id)
      .map((a) => ({ ...a, payload: parse(a.payload, {}) })),
    audit: db.prepare('SELECT * FROM audit WHERE enquiry_id=? ORDER BY id').all(req.params.id)
  });
});

app.get('/api/crm', (_req, res) => {
  res.json({
    records: db.prepare('SELECT * FROM crm_records ORDER BY id').all()
      .map((r) => ({ ...r, parse_flags: parse(r.parse_flags, []) })),
    duplicates: db.prepare("SELECT * FROM matches WHERE target_kind='crm_pair'").all()
  });
});

app.get('/api/audit', (_req, res) => {
  res.json(db.prepare('SELECT * FROM audit ORDER BY id').all());
});

app.get('/api/policy', (_req, res) => res.json(POLICY));

/**
 * Approval is checked against the token stored with the action. The client sends the
 * token back, but it is compared server side and cleared once used.
 */
app.post('/api/actions/:id/approve', async (req, res) => {
  try {
    res.json(await approve(Number(req.params.id), req.body.token, req.body.approver || 'reviewer'));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/actions/:id/reject', (req, res) => {
  try {
    res.json(reject(Number(req.params.id), req.body.approver || 'reviewer', req.body.reason));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/run', async (_req, res) => {
  try { res.json(await runAll({ fresh: true })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

const port = process.env.PORT || 3000;

if (!db.prepare('SELECT count(*) c FROM enquiries').get().c) {
  await runAll({ fresh: true });
  console.log('pipeline run on first start');
}
app.listen(port, () => console.log(`BEDA triage review UI on http://localhost:${port}`));
