# BEDA enquiry triage — Test 2

Ingests the supplied enquiries, classifies them, extracts structured fields, resolves
identity against the CRM seed, decides a next action, drafts a reply, and holds every
consequential action for human approval. Everything it does is written to an audit log.

**Build time:** started HH:MM, finished HH:MM WIB (see *Unfinished* at the end).

## Run it

```bash
npm install
cp .env.example .env
npm run run:pipeline     # process all 12 enquiries and print a summary
npm start                # review UI on http://localhost:3000
```

No API key is needed. `LLM_MODE=fixture` (the default) replays stored model output so
the pipeline is fully runnable offline; the code below the model is identical either way.
To use a live model, set `LLM_MODE=live` and `OPENROUTER_API_KEY` in `.env`.

Also available: `npm run audit` for the full trail, `node src/cli.js audit E010` for one enquiry.

## Architecture

```
load → pre-checks → classify+extract (LLM) → verify spans → identity
     → routing rules → draft → ACTION GATE → execute
                                    ↓
                                audit_log (append only)
```

Nine stages, one SQLite database, one state machine. The governing rule is the same as
Test 1: **the LLM decides what an enquiry means, deterministic code decides what the
system is allowed to do.** There is exactly one function (`dispatch` in `src/actions.js`)
that can reach an executor, so text arriving from a sender cannot trigger an action even
if it is written as an instruction.

| LLM | Deterministic code |
|---|---|
| Category, field extraction, one-line rationale | Owner assignment, priority, next action |
| — | Email/phone normalisation, duplicate detection, invoice arithmetic |
| — | Everything that writes, sends or commits |

Replies are assembled from templates filled with verified fields rather than generated,
so a draft cannot contain a fact the sender did not supply. Live-model drafting is the
obvious next step but was not worth the risk inside the time limit.

## Key behaviours

- **Source-span verification** — every extracted field carries the text it came from, and
  code checks that span exists in the message. Unfound spans are dropped, not trusted.
  Replaces a self-reported confidence score with a check that can actually be performed.
- **Duplicates** — C001/C002 are flagged as the same organisation; CRM writes to either are
  held until a human merges. E001/E002 are linked as one request across two channels.
- **Conflicts preserved** — E009 and E010 give different phone numbers. Both are kept, the
  later is treated as current, the earlier is marked superseded, and the conflict is audited.
- **No owner is better than a wrong owner** — E006 (engineering) and E007 (recruitment) have
  no matching role in the directory, so they escalate rather than being assigned by guess.
- **Never automated** — confirming a crew for E008 is `NEVER_AUTO`. It cannot be approved
  through the UI at all; it is handed to a human in full.
- **Missing data is a state, not an error** — E005 cannot be assessed for government
  incentives because funding type was never stated, and the system says so rather than inferring it.

## Choices worth explaining

**SQLite, not Postgres.** The reviewer needs to run this with `npm install`, not set up a
database server. Schema and queries are plain SQL and would move to Postgres unchanged.

**Two attachments were referenced but not supplied** (`01_hume_energy_bill.txt`,
`02_northbank_site_notes.txt`). They are recorded as referenced-but-unavailable and added
to each enquiry's missing list. Their contents were not invented.

**E007–E012 arrived as descriptions rather than raw email text.** They are stored verbatim
with `provenance: "supplied_as_description"` rather than rewritten into plausible emails.
Rewriting them would mean source-span verification was checking text I had authored.

## AI tools and models used

- Claude (Anthropic) for design discussion and code drafting.
- `openai/gpt-4o-mini` via OpenRouter for classification and extraction in live mode,
  chosen because the task has a fixed schema and a larger model does not change the answer.
- Fixture mode ships stored output of that same prompt so the system runs without a key.

## Known weaknesses

- Fixture mode is the default, so the classifier is not exercised on every run. Live mode
  works but is not covered by tests.
- No automated tests. Behaviour was verified by reading the audit log for each enquiry.
- Company-name matching uses a trigram score with a hand-set threshold that has not been
  tuned against real data.
- Draft templates cover the categories in this data pack and would need extending.
- CRM and mail executors are stubs; nothing is actually written or sent.
- Approval identity is a name in a request body. Real deployment needs authenticated
  reviewers and per-role permissions.
- Single-process, in-order pipeline. Fine for 12 items, not for a real inbox.

## With another day

1. Tests for the deterministic core — normalisation, dedupe, invoice reconciliation and
   the action gate are all pure functions and should not be verified by eye.
2. Real authentication on approval, with the approver identity recorded from the session.
3. Live-model drafting constrained to verified fields, with a diff against the template
   version so the model's additions are visible before sending.
4. A reviewer queue ordered by priority and age rather than by enquiry ID.

## Unfinished

_(state what you stopped on at the 3-hour mark)_
