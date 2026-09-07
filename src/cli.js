import { db } from './db.js';
import { runAll } from './pipeline.js';

const cmd = process.argv[2] || 'run';
const arg = process.argv[3];

const line = (n = 78) => console.log('-'.repeat(n));

function report() {
  const rows = db.prepare(`
    SELECT e.id, e.channel, e.status, x.category, x.missing, x.fields,
           (SELECT group_concat(type || ':' || state, ', ') FROM actions a WHERE a.enquiry_id = e.id) AS acts,
           (SELECT group_concat(target_id || '(' || decision || ')', ', ') FROM matches m WHERE m.enquiry_id = e.id) AS links
    FROM enquiries e LEFT JOIN extractions x ON x.enquiry_id = e.id
    ORDER BY e.id`).all();

  for (const r of rows) {
    line();
    const missing = JSON.parse(r.missing || '[]');
    const fields = JSON.parse(r.fields || '{}');
    const verified = Object.entries(fields).filter(([, f]) => f.value !== null).map(([k]) => k);
    const dropped = Object.entries(fields).filter(([, f]) => f.unverified).map(([k]) => k);

    console.log(`${r.id}  [${r.category ?? 'n/a'}]  ${r.channel}  status=${r.status}`);
    if (verified.length) console.log(`  verified fields : ${verified.join(', ')}`);
    if (dropped.length)  console.log(`  DROPPED (span not found): ${dropped.join(', ')}`);
    if (missing.length)  console.log(`  missing         : ${missing.join(', ')}`);
    if (r.links)         console.log(`  matches         : ${r.links}`);
    if (r.acts)          console.log(`  actions         : ${r.acts}`);
  }

  line();
  const pending = db.prepare("SELECT count(*) c FROM actions WHERE state='awaiting_approval'").get().c;
  const blocked = db.prepare("SELECT count(*) c FROM actions WHERE state='blocked'").get().c;
  const executed = db.prepare("SELECT count(*) c FROM actions WHERE state='executed'").get().c;
  console.log(`actions: ${executed} executed automatically, ${pending} awaiting approval, ${blocked} blocked as never-auto`);
}

function showAudit(id) {
  const rows = id
    ? db.prepare('SELECT * FROM audit WHERE enquiry_id = ? ORDER BY id').all(id)
    : db.prepare('SELECT * FROM audit ORDER BY id').all();
  for (const r of rows) {
    console.log(`${r.at}  ${(r.enquiry_id ?? '----').padEnd(5)} ${r.stage.padEnd(12)} ${r.event}`);
    if (r.reason) console.log(`${' '.repeat(26)}${r.reason}`);
  }
  console.log(`\n${rows.length} audit entries`);
}

if (cmd === 'run') {
  const counts = await runAll({ fresh: true });
  console.log(`loaded ${counts.crm} CRM rows and ${counts.enquiries} enquiries\n`);
  report();
} else if (cmd === 'report') {
  report();
} else if (cmd === 'audit') {
  showAudit(arg);
} else {
  console.log('usage: node src/cli.js [run|report|audit [ENQUIRY_ID]]');
}
