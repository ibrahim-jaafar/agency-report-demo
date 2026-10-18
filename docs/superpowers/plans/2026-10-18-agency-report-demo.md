# Agency Report Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A public, free, live demo: a recruiter clicks "Run the demo" on ibrahim-jaafar.github.io, an n8n workflow on Hugging Face creates and reads leads in a GoHighLevel sandbox, sends conversions to Meta as test events, runs code-based data checks, has an AI write a summary, and the page shows the run live and ends on an agency overview report.

**Architecture:** All business logic (lead generation, KPIs, checks, Meta event building, AI validation, report assembly, run limits) lives in small pure JavaScript modules in `lib/`, tested with Node's built-in test runner. A build script injects those modules into n8n Code nodes in the workflow JSON, so the logic n8n runs is the logic that was tested. n8n (Hugging Face Space, Supabase Postgres) does the I/O: webhooks, GHL/Meta/AI HTTP calls, and a `demo_runs` table that holds progress, reports and limits. The static demo page polls a status webhook.

**Tech Stack:** Node 20+ (no npm dependencies), n8n Community Edition (Docker), Supabase Postgres, GoHighLevel API v2, Meta Conversions API, an OpenAI-compatible chat API with JSON-schema output (model chosen in Task 9), plain HTML/CSS/JS on GitHub Pages.

**Spec:** `docs/superpowers/specs/2026-10-18-agency-report-demo-design.md`

## Global Constraints

- Free only; no card if avoidable. Ibrahim creates every account himself; Claude never signs up or types his passwords.
- No keys, tokens or passwords in the repo or the page — only in n8n credentials / Space secrets. `.env` is git-ignored.
- AI input contains aggregates and warnings only: never names, emails, phones or any personal data.
- Data checks are plain code; the AI only writes text and may not change a number or a warning.
- Clients: **Lumière Skin Clinic** (`clinic`: leads → booked consultations) and **Northwind Home** (`store`: leads → orders). Fictional.
- Report period: a 7-day week in UTC, `[weekStart, weekStart + 7 days)`.
- Limits: one run at a time, 60 s minimum gap, 50 runs per UTC day. Demo-lead clean-up age: 7 days. New leads per client per run: 6–12.
- Scenario whitelist: modes `random` (default) · `clean` · `custom`; problems `missing_source` · `duplicates` · `meta_mismatch` · `bad_totals` · `edge_cases` · `ai_broken`.
- Webhook CORS: `https://ibrahim-jaafar.github.io` only.
- Demo page matches the portfolio (dark theme, same CSS tokens/fonts/gradient), works at 390 px and desktop, no horizontal scroll.
- Every public claim must match what runs; the page states what is live and what is simulated.
- Wording on the portfolio site and profile.md needs Ibrahim's approval before it ships (his standing rule).

## Review Focus

- Two visitors click Run at the same time → the second watches the first run instead of getting an error (test in Task 7: `checkLimits` returns `reason:'running'` with the active `runId`).
- The visitor closes the tab mid-run and comes back → the run finishes anyway and the page shows it as the latest report (Task 11 status webhook without `runId`; Task 13 verification).
- A hand-crafted POST to the start webhook (unknown keys, huge arrays, wrong types) → treated as `random`, nothing else read (test in Task 1).
- The AI answers with a number that isn't in the data, extra prose, or invalid JSON → template summary, never shown raw (tests in Task 6).
- The Space is asleep or the status call times out → "Waking up the demo server" state, auto-retry, never a frozen page (test in Task 13).

---

## File structure

```
agency-report-demo/                       (this repo, private until Ibrahim publishes it)
  package.json                            {"type":"module","scripts":{"test":"node --test","build":"node scripts/build-workflows.mjs"}}
  .gitignore                              .env, dist/
  lib/rng.js                              seeded random
  lib/scenario.js                         parse + resolve the test scenario (whitelist)
  lib/leads.js                            demo-lead generator, normalisers, period filter
  lib/spend.js                            simulated ad spend
  lib/kpis.js                             KPI maths with safe zero handling
  lib/checks.js                           the data checks + "which injected problem was caught"
  lib/meta.js                             Meta CAPI event building + hashing
  lib/ai.js                               AI input, JSON schema, validation, template fallback
  lib/limits.js                           run-limit decision
  lib/report.js                           report + status lights + comparison with previous run
  test/*.test.js                          one test file per lib module
  db/schema.sql                           demo_runs table
  workflows/src/*.json                    n8n workflow templates with /*@lib*/ markers in Code nodes
  scripts/build-workflows.mjs             injects lib/ into templates → dist/*.json
  docs/troubleshooting.md                 guide for a non-technical account manager
  README.md
ibrahim-jaafar.github.io/                 (portfolio repo, public)
  agency-demo/index.html                  the demo page
  agency-demo/app.js                      pure render functions + DOM wiring (ES module)
  agency-demo/app.test.mjs                tests for the render functions
  agency-demo/workflow.webp               screenshot of the n8n workflow
  index.html, profile.md                  new project card / profile entry (Task 14)
```

Shared types (used across tasks):

```js
// Lead      {id, firstName, lastName, email, phone, source: string|null, createdAt: ISO string,
//            outcome: 'converted'|'cancelled'|'open', value: number, flags: string[]}
// Spend     {campaigns: [{name, spend, paidLeads}], reportedTotal: number, simulated: true}
// Kpis      clinic: {spend, leads, paidLeads, costPerLead, bookings, costPerBooking, bookingRate, cancelled}
//           store:  {spend, leads, paidLeads, orders, revenue, roas, costPerOrder, avgOrderValue, cancelled}
//           any ratio with a zero denominator is null (never Infinity/NaN)
// Warning   {code: 'meta_mismatch'|'missing_source'|'duplicates'|'bad_totals'|'outlier'|'meta_rejected',
//            count: number, message: string}            // message is client-friendly English
// MetaResult {sent: number, accepted: number, rejected: number}
// StepState {key: 'ghl'|'spend'|'meta'|'checks'|'ai', status: 'pending'|'running'|'done'|'warning'|'failed', reason?: string}
```

---

### Task 1: Repo scaffold, seeded random, scenario parsing

**Files:**
- Create: `package.json`, `.gitignore`, `lib/rng.js`, `lib/scenario.js`
- Test: `test/rng.test.js`, `test/scenario.test.js`

**Interfaces:**
- Produces: `makeRng(seed: number) => () => number` (deterministic, [0,1)); `PROBLEMS` (the six problem keys, in the order of Global Constraints); `parseScenario(body: unknown) => {mode, problems: string[]}`; `resolveProblems(scenario, rng) => string[]` (for `random`: each of `missing_source`, `duplicates`, `meta_mismatch`, `bad_totals`, `edge_cases` included with probability 0.35, never `ai_broken`; `clean` → `[]`; `custom` → its problems).

- [ ] **Step 1: Write the failing tests**

```js
test('same seed gives the same sequence', () => { const a = makeRng(42), b = makeRng(42); assert.deepEqual([a(),a(),a()], [b(),b(),b()]); });
test('missing or junk body falls back to random', () => {
  for (const b of [undefined, null, 'x', 7, [], {mode:'evil'}, {mode:'custom', problems:'duplicates'}])
    assert.deepEqual(parseScenario(b), {mode:'random', problems:[]});
});
test('custom keeps only whitelisted, unique problems, max 6', () => {
  assert.deepEqual(parseScenario({mode:'custom', problems:['duplicates','rm -rf','duplicates','ai_broken'], extra:1}),
    {mode:'custom', problems:['duplicates','ai_broken']});
  assert.equal(parseScenario({mode:'custom', problems:Array(10000).fill('duplicates')}).problems.length, 1);
});
test('clean resolves to no problems; random never includes ai_broken', () => {
  assert.deepEqual(resolveProblems({mode:'clean', problems:[]}, makeRng(1)), []);
  for (let s = 0; s < 200; s++) assert.ok(!resolveProblems({mode:'random', problems:[]}, makeRng(s)).includes('ai_broken'));
});
```

- [ ] **Step 2: Run `node --test` — expect FAIL (modules missing)**
- [ ] **Step 3: Implement `lib/rng.js` (mulberry32) and `lib/scenario.js`.** Only `export function` / `export const` at top level, no imports between lib files except via parameters (the build script concatenates files; see Task 8). `custom` with zero valid problems behaves like `clean`.
- [ ] **Step 4: Run `node --test` — expect PASS**
- [ ] **Step 5: Commit** `feat: scaffold, seeded rng, scenario whitelist`

### Task 2: Demo-lead generator, normalisers, period filter

**Files:**
- Create: `lib/leads.js` · Test: `test/leads.test.js`

**Interfaces:**
- Consumes: `makeRng`.
- Produces: `generateLeads(client: 'clinic'|'store', problems: string[], rng, weekStart: Date) => Lead[]`; `normalisePhone(s) => string` (digits only, Lebanese `+961`/`00961`/leading `0` → same national form); `normaliseEmail(s) => string` (trim, lowercase); `inPeriod(lead, weekStart) => boolean`.

Generator rules: 6–12 leads; ~15 % `source: 'organic'`, rest from the client's 3 campaigns; clinic ~30 % converted, store ~25 %; store values $40–$400, clinic value = consultation fee $150. Flags record every injected flaw so checks can be matched later.
- `missing_source` → 1–3 leads with `source: null`, flag `missing_source`.
- `duplicates` → 1–2 copies of an existing lead with the phone reformatted (spaces / `+961` vs `0`) and the email in capitals, flag `duplicates`.
- `edge_cases` → one cancelled conversion; one Arabic-script name and one name with an emoji; for `store` one order at 10× the median value (flag `outlier`); one lead at `weekStart + 7d − 1 ms` and one at exactly `weekStart + 7d` (flag `boundary`); for `clinic` with probability 0.5 zero leads instead (whole list empty, flag on nothing). The same email is used once at both clients (not a duplicate).

- [ ] **Step 1: Write the failing tests**

```js
test('clean scenario: 6-12 leads, all in period, no flags', () => { const l = generateLeads('store', [], makeRng(3), W);
  assert.ok(l.length >= 6 && l.length <= 12); assert.ok(l.every(x => inPeriod(x, W) && x.flags.length === 0)); });
test('phone and email normalise to the same key', () => {
  assert.equal(normalisePhone('+961 70 123 456'), normalisePhone('070123456'));
  assert.equal(normalisePhone('00961-70-123456'), normalisePhone('70 123 456'));
  assert.equal(normaliseEmail('  Sara@Mail.COM '), 'sara@mail.com'); });
test('period is half-open', () => {
  assert.ok(inPeriod({createdAt: new Date(+W + 7*864e5 - 1).toISOString()}, W));
  assert.ok(!inPeriod({createdAt: new Date(+W + 7*864e5).toISOString()}, W)); });
test('each injected problem leaves its flag', () => { for (const p of ['missing_source','duplicates'])
  assert.ok(generateLeads('clinic', [p], makeRng(9), W).some(l => l.flags.includes(p))); });
test('edge cases include arabic and emoji names', () => { const l = generateLeads('store', ['edge_cases'], makeRng(5), W);
  assert.ok(l.some(x => /[\u0600-\u06FF]/.test(x.firstName + x.lastName))); assert.ok(l.some(x => /\p{Extended_Pictographic}/u.test(x.firstName + x.lastName))); });
```
(`W = new Date('2026-10-12T00:00:00Z')`.)

- [ ] **Step 2: Run `node --test test/leads.test.js` — expect FAIL**
- [ ] **Step 3: Implement `lib/leads.js`**
- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit** `feat: demo lead generator with flaws and edge cases`

### Task 3: Simulated spend and KPIs

**Files:**
- Create: `lib/spend.js`, `lib/kpis.js` · Test: `test/spend.test.js`, `test/kpis.test.js`

**Interfaces:**
- Consumes: `Lead`, `inPeriod`.
- Produces: `simulateSpend(client, leads, problems, rng) => Spend` (spend per campaign = paid leads × $15–$30; `reportedTotal` = exact sum, or with `bad_totals` off by 5–20 %); `computeKpis(client, leads, spend, weekStart) => Kpis` (only `inPeriod` leads; organic leads count as leads but not paid leads; cost per lead = spend / paidLeads; cancelled conversions excluded from bookings/orders/revenue and counted in `cancelled`; ratios with zero denominator → `null`; money rounded to cents).

- [ ] **Step 1: Write the failing tests**

```js
test('zero leads gives nulls, not NaN or Infinity', () => { const k = computeKpis('clinic', [], simulateSpend('clinic', [], [], makeRng(1)), W);
  assert.equal(k.leads, 0); assert.equal(k.costPerLead, null); assert.equal(k.bookingRate, null); });
test('organic leads do not lower cost per lead', () => { /* 2 paid + 2 organic, spend 60 */ assert.equal(k.costPerLead, 30); });
test('cancelled orders are excluded from revenue and counted', () => { /* 1 converted $100, 1 cancelled $50 */ assert.equal(k.revenue, 100); assert.equal(k.cancelled, 1); });
test('lead exactly at week end is excluded', () => { /* boundary lead */ assert.equal(k.leads, 1); });
test('bad_totals makes reportedTotal differ from the sum', () => { const s = simulateSpend('store', leads, ['bad_totals'], makeRng(2));
  assert.notEqual(s.reportedTotal, s.campaigns.reduce((a,c) => a + c.spend, 0)); });
```

- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement both modules**
- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit** `feat: simulated spend and safe KPI maths`

### Task 4: Data checks and "what was caught"

**Files:**
- Create: `lib/checks.js` · Test: `test/checks.test.js`

**Interfaces:**
- Consumes: `Lead`, `Spend`, `MetaResult`, `normalisePhone`, `normaliseEmail`, `inPeriod`.
- Produces: `runChecks({client, leads, spend, meta, weekStart}) => Warning[]`; `matchInjected(problems: string[], warnings: Warning[]) => [{problem, caught: boolean}]` (mapping: `missing_source`→`missing_source`, `duplicates`→`duplicates`, `meta_mismatch`→`meta_mismatch`, `bad_totals`→`bad_totals`, `edge_cases`→ caught when the store's warnings include both `outlier` and `meta_rejected` (the other edge cases are proven by the run finishing with no `null`/NaN crash, Task 12 Step 4); `ai_broken` is matched in Task 7 from the AI step, not here).

Checks: `meta_mismatch` when `meta.accepted` ≠ converted (non-cancelled) in-period leads; `missing_source` when any `source === null`; `duplicates` per client by normalised phone OR email (same person at the other client is never compared); `bad_totals` when `|reportedTotal − Σ campaigns| > 0.01`; `outlier` when an order value > 5 × the median order (store, ≥ 3 orders); `meta_rejected` when `meta.rejected > 0`. Messages are plain English for a client, e.g. "3 leads have no recorded source, so we can't tell which ad brought them."

- [ ] **Step 1: Write the failing tests** — one test per check (fires when the flaw exists, silent on clean data), plus:

```js
test('same person at both clients is not a duplicate', () => { assert.ok(!runChecks({client:'clinic', leads: clinicLeads, ...}).some(w => w.code === 'duplicates')); });
test('duplicates found across formatting', () => { /* '+961 70 123 456' vs '070123456', 'A@B.COM' vs 'a@b.com' */ assert.equal(w.find(x => x.code==='duplicates').count, 1); });
test('matchInjected reports misses honestly', () => { assert.deepEqual(matchInjected(['duplicates','bad_totals'], [{code:'duplicates',count:1,message:''}]),
  [{problem:'duplicates', caught:true}, {problem:'bad_totals', caught:false}]); });
```

- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement `lib/checks.js`**
- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit** `feat: code-based data checks`

### Task 5: Meta Conversions API events

**Files:**
- Create: `lib/meta.js` · Test: `test/meta.test.js`

**Interfaces:**
- Consumes: `Lead`.
- Produces: `hashField(value: string, sha256: (s) => hexString) => string` (trim, lowercase, UTF-8, then sha256; empty → omitted); `buildMetaEvents(client, leads, problems, nowSec: number, sha256) => {events: object[], edgeEvents: object[], skipped: number}`. One event per non-cancelled conversion: `event_name` `Schedule` (clinic) / `Purchase` (store, with `custom_data.value` and `currency:'USD'`), `event_time` = lead time in seconds, `action_source:'system_generated'`, `event_id` = lead id (dedup), `user_data.em`/`ph`/`fn`/`ln` hashed. With `meta_mismatch`, 1–2 conversions are left out (`skipped`). With `edge_cases`, one event goes into `edgeEvents` with `event_time` 10 days ago (Meta rejects events older than 7 days) — sent as its own request so it can't fail the main batch.

- [ ] **Step 1: Write the failing tests**

```js
const sha = s => createHash('sha256').update(s, 'utf8').digest('hex');
test('hash normalises before hashing', () => assert.equal(hashField('  Sara@Mail.COM ', sha), sha('sara@mail.com')));
test('arabic and emoji names hash without throwing', () => { assert.match(hashField('سارة', sha), /^[0-9a-f]{64}$/); assert.match(hashField('Zoë 🌸', sha), /^[0-9a-f]{64}$/); });
test('no raw personal data in events', () => { const {events} = buildMetaEvents('clinic', leads, [], NOW, sha);
  assert.ok(!JSON.stringify(events).includes(leads[0].email)); });
test('cancelled conversions are not sent; mismatch skips some', () => { /* counts */ });
```

- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement `lib/meta.js`**
- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit** `feat: Meta CAPI event builder with hashing`

### Task 6: AI input, strict schema, validation, template fallback

**Files:**
- Create: `lib/ai.js` · Test: `test/ai.test.js`

**Interfaces:**
- Consumes: `Kpis`, `Warning`.
- Produces: `buildAiInput(clients: [{client, name, kpis, previousKpis|null, warnings}]) => object` (numbers, names of the fictional businesses and warning messages only); `AI_SCHEMA` (JSON Schema, `additionalProperties:false` everywhere): `{overview: string ≤ 200 chars, clients: [{client: 'clinic'|'store', headline: string ≤ 90, summary: string ≤ 600, warnings_explained: string[] ≤ 6, next_steps: string[] ≤ 3}] (exactly 2)}`; `validateAiOutput(raw: string|object, input) => {ok: true, value} | {ok: false, errors: string[]}` (parses JSON if string, checks the schema by hand — no library — and that every number written in the text, after stripping `$ , %`, equals a number in `input` rounded to 1 decimal, or a percentage change computed from current vs previous); `templateSummary(input) => AiOutput` (deterministic, always valid).

- [ ] **Step 1: Write the failing tests**

```js
test('input carries no personal fields', () => { const s = JSON.stringify(buildAiInput(sample)); for (const k of ['email','phone','firstName','lastName']) assert.ok(!s.includes(k)); });
test('rejects invalid JSON, prose, extra keys, wrong client count', () => { for (const bad of ['not json', '{"overview":"x"}', JSON.stringify({...good, extra:1})]) assert.equal(validateAiOutput(bad, input).ok, false); });
test('rejects a number that is not in the data', () => { const o = structuredClone(good); o.clients[0].summary = 'Leads rose to 999.'; assert.equal(validateAiOutput(o, input).ok, false); });
test('accepts a correct answer', () => assert.equal(validateAiOutput(good, input).ok, true));
test('template is always valid', () => { for (const s of samples) assert.equal(validateAiOutput(templateSummary(s), s).ok, true); });
```

- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement `lib/ai.js`**
- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit** `feat: AI schema, validation and template fallback`

### Task 7: Run limits and report assembly

**Files:**
- Create: `lib/limits.js`, `lib/report.js` · Test: `test/limits.test.js`, `test/report.test.js`

**Interfaces:**
- Produces: `GAP_SEC = 60`, `DAILY_MAX = 50`; `checkLimits(runs: [{id, created_at, status}], now: Date) => {ok: true} | {ok: false, reason: 'running'|'gap'|'daily', runId?, retryAfterSec}` (`running` wins and returns the active run's id; a run stuck `running` for > 10 min is ignored); `buildReport({runId, weekStart, clients: [{client, name, kpis, previousKpis, warnings, injected}], steps: StepState[], ai: {source: 'ai'|'template', value}, problems}) => Report` with `light` per client: `red` if a step that feeds it failed, else `orange` if warnings, else `green`; `partial: true` if any step failed; `changes` = % change per KPI vs previous (null when previous missing or zero); `injected` list includes `{problem:'ai_broken', caught: ai.source === 'template'}` when requested.

- [ ] **Step 1: Write the failing tests**

```js
test('second click joins the running run', () => assert.deepEqual(checkLimits([{id:'r1', created_at:T0, status:'running'}], T0plus5s), {ok:false, reason:'running', runId:'r1', retryAfterSec:0}));
test('gap and daily cap', () => { /* 30 s after a done run → gap, retryAfterSec 30; 50 runs today → daily */ });
test('stuck run older than 10 min does not block', () => { /* ok:true */ });
test('lights and partial', () => { /* meta failed → store red, partial true; clean → both green */ });
test('change vs previous is null when previous is zero', () => { /* changes.leads === null */ });
```

- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement both modules**
- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit** `feat: run limits and report assembly`

### Task 8: Workflow build script

**Files:**
- Create: `scripts/build-workflows.mjs`, `workflows/src/demo-run.json`, `workflows/src/demo-status.json`, `workflows/src/error-handler.json` (skeletons; filled in Tasks 11–12) · Test: `test/build.test.js`

**Interfaces:**
- Produces: `npm run build` → `dist/<same names>.json`. In every Code node whose `jsCode` contains the line `/*@lib*/`, that line is replaced by all `lib/*.js` files concatenated in a fixed order (rng, scenario, leads, spend, kpis, checks, meta, ai, limits, report) with `export ` removed. Templates never contain lib code themselves.

- [ ] **Step 1: Write the failing test** — build a tiny template with one Code node `"/*@lib*/\nreturn [{json:{ok: typeof checkLimits}}]"`, run the build, `assert.ok(!out.includes('export '))`, and `new Function(code)` it to prove the injected code parses and defines `checkLimits`.
- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement the script (Node `fs` only)**
- [ ] **Step 4: Run `node --test` — expect PASS (all tasks so far)**
- [ ] **Step 5: Commit** `feat: build script injects tested lib into n8n Code nodes`

### Task 9: Accounts (Ibrahim, guided by Claude)

Manual task; Claude explains each screen, Ibrahim clicks and types. Values go only into Space secrets / n8n credentials, never into chat or the repo.

- [ ] **Step 1: Decide the AI model** (open item from the spec) — must have a free tier and JSON-schema structured output on an OpenAI-compatible endpoint. Record the choice in the spec §10.
- [ ] **Step 2: Hugging Face account; Supabase account + project** (region nearest Europe). Check: Supabase dashboard shows the project; note the transaction-pooler connection settings.
- [ ] **Step 3: GHL developer account → Testing tab → sandbox; create 2 sub-accounts named after the two clients; a Private Integration token per sub-account** with contacts + opportunities read/write. Confirm the sandbox costs nothing; if it does, stop and ask Ibrahim (fallback: 14-day trial). Check: a `curl` listing contacts returns 200 for both.
- [ ] **Step 4: Meta Business account → Events Manager → new dataset (pixel) → Conversions API access token → Test Events code.** Check: one `curl` test event appears in Test Events.
- [ ] **Step 5: AI provider key.** Check: one `curl` chat call with `response_format: {type:'json_schema', ...}` returns valid JSON.

### Task 10: Database and n8n on Hugging Face

**Files:**
- Create: `db/schema.sql`, `README.md` (setup section)

- [ ] **Step 1: Write `db/schema.sql`:** `create table demo_runs (id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now(), status text not null check (status in ('running','done','partial','failed')), scenario jsonb not null, steps jsonb not null, report jsonb, error text); create index on demo_runs (created_at desc);` Run it in Supabase's SQL editor. Check: `select count(*) from demo_runs` → 0.
- [ ] **Step 2: Duplicate a public n8n Space template; set Space secrets:** `DB_TYPE=postgresdb`, `DB_POSTGRESDB_*` (pooler), `N8N_ENCRYPTION_KEY` (32 random bytes, also saved in Ibrahim's password manager), `GENERIC_TIMEZONE=UTC`, `NODE_FUNCTION_ALLOW_BUILTIN=crypto`, `N8N_DIAGNOSTICS_ENABLED=false`, `WEBHOOK_URL=https://<space>.hf.space/`.
- [ ] **Step 3: Open the Space and create the n8n owner account immediately.** Check: a private window shows the n8n login screen, not setup.
- [ ] **Step 4: Restart the Space.** Check: the owner account and a test workflow survive (proves Supabase persistence).
- [ ] **Step 5: Commit** `docs: schema and hosting setup`

### Task 11: Start and status webhooks

**Files:**
- Modify: `workflows/src/demo-run.json` (start section), `workflows/src/demo-status.json`

**Interfaces:**
- `POST /webhook/demo/start` body `{mode, problems}` → `200 {runId, joined: boolean}` or `429 {reason, retryAfterSec, latest: Report|null}`. Flow: `parseScenario` → read today's runs → `checkLimits` → if `running`, return its id with `joined:true`; else insert a `running` row with all steps `pending`, respond, continue the pipeline (Task 12) after "Respond to Webhook".
- `GET /webhook/demo/status?run=<uuid>` → `{runId, status, steps, report|null}`; without `run` (or unknown/invalid uuid) → latest `done`/`partial` run. Invalid uuid never reaches SQL as text (query parameters only).
- Both webhooks: Allowed Origins `https://ibrahim-jaafar.github.io`.

- [ ] **Step 1: Build the two flows in the n8n editor using `/*@lib*/` Code nodes; export into `workflows/src/`; `npm run build`; import `dist/` back.**
- [ ] **Step 2: Verify with curl:** start → `runId`; immediate second start → same `runId`, `joined:true`; after the run finishes, start again within 60 s → `429 gap`; status with `run=not-a-uuid` → latest run, no error; a request with `Origin: https://evil.example` gets no CORS allow header.
- [ ] **Step 3: Commit** `feat: start and status webhooks`

### Task 12: The run pipeline

**Files:**
- Modify: `workflows/src/demo-run.json` (pipeline), `workflows/src/error-handler.json`

Each step updates its `StepState` in `demo_runs.steps` when it starts and ends, so the page can follow along. A failing external call marks its step `failed` with a plain reason and the pipeline continues with what it has.

- [ ] **Step 1: Check the GHL v2 API reference** for the exact create-contact, create-opportunity, search and delete endpoints and the `Version` header; note them in the README. Leads are stored as contacts (tag `demo`, tag `run:<runId>`, custom field for `createdAt`) plus an opportunity per conversion (status `won`, or `lost` for cancelled; `monetaryValue`).
- [ ] **Step 2: Pipeline nodes, in order:** generate leads per client (`resolveProblems`, `generateLeads` with `weekStart` = Monday 00:00 UTC of the current week) → create in GHL → read back from GHL by `run:<runId>` tag (the report uses what GHL returns, not what was generated) → `simulateSpend` → `buildMetaEvents` → POST events (and edge events separately) to `https://graph.facebook.com/<version>/<datasetId>/events` with `test_event_code` → `MetaResult` from the responses → `computeKpis` + `runChecks` + `matchInjected` → AI call with `AI_SCHEMA` (if `ai_broken` was chosen, replace the reply with `"Sorry, I can't help with that."` before validation) → `validateAiOutput`, retry once, else `templateSummary` → read the previous `done` run's KPIs → `buildReport` → save `report` and final `status` → delete GHL contacts tagged `demo` older than 7 days.
- [ ] **Step 3: Error workflow:** set as the workflow's error workflow; marks the run `failed` with the error message so the page never waits forever.
- [ ] **Step 4: Verify each scenario with curl + status polling:** `clean` → both lights green, Test Events shows the conversions; `custom ['duplicates','missing_source']` → both caught; `custom ['ai_broken']` → `ai.source:'template'`, caught; `custom ['edge_cases']` → no `null`-related crash, `meta_rejected` warning, run `done`; temporarily break the Meta token → store light red, report `partial`, run still ends. Restore the token.
- [ ] **Step 5: Export, build, commit** `feat: run pipeline`

### Task 13: Demo page

**Files:**
- Create: `ibrahim-jaafar.github.io/agency-demo/index.html`, `agency-demo/app.js`, `agency-demo/app.test.mjs`, `agency-demo/workflow.webp`

**Interfaces:**
- Consumes: the two webhooks (Task 11), `Report`, `StepState`.
- Produces in `app.js`: `renderSteps(steps) => string`, `renderCards(report|null, steps) => string`, `renderClientReport(report, client) => string`, `renderNotice(kind: 'waking'|'limit'|'failed'|'partial', info) => string`, `fmt(value, kind: 'money'|'int'|'pct'|'ratio') => string` (`null` → `"—"`, never `NaN`/`Infinity`), and `boot()` for the DOM. All text set via escaping (`textContent` or an `esc()` helper), never raw report strings into `innerHTML`.

Page: intro + "What's real here?" disclosure (live: GHL, Meta test events, checks, AI summary; made up: the two clients, their leads, ad spend, chosen flaws, and that demo data may contain deliberate mistakes) → test-scenario panel (Random default · Clean data · Choose problems with the six checkboxes, labelled in plain English) → Run button → step strip → two client cards → full report in a dialog on card click (KPIs with change vs previous, AI summary, warnings, "caught / missed" per chosen problem, "summary written by template" note when `ai.source === 'template'`) → workflow screenshot under "How this was made". On load: show the latest report. Polling every 1.5 s while running. If the first status call fails or takes > 8 s: waking notice, retry every 5 s for up to 120 s, then a "demo server unavailable, try later" notice with the last report if any. Reuse the portfolio's CSS tokens.

- [ ] **Step 1: Write the failing tests** (`node --test agency-demo/app.test.mjs`)

```js
test('null and zero-division values render as a dash', () => { assert.equal(fmt(null,'money'), '—'); assert.equal(fmt(Infinity,'pct'), '—'); assert.equal(fmt(NaN,'int'), '—'); });
test('report text is escaped', () => assert.ok(!renderClientReport(reportWith('<img src=x onerror=alert(1)>'), 'clinic').includes('<img')));
test('failed step shows its reason', () => assert.match(renderSteps([{key:'meta', status:'failed', reason:"Meta didn't respond"}]), /Meta didn't respond|Meta didn&#39;t respond/));
test('waking notice', () => assert.match(renderNotice('waking'), /Waking up the demo server/));
test('template note appears when AI fell back', () => assert.match(renderClientReport(templateReport, 'store'), /template/i));
```

- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement `app.js` and `index.html`**
- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Browser check (Chrome DevTools) at 390 px and 1440 px:** a Random run end to end, a Clean run, a Choose-problems run, and the waking notice (point the page at a wrong Space URL temporarily). No horizontal scroll, no console errors.
- [ ] **Step 6: Commit in the portfolio repo (do not push yet)** `feat: agency report demo page`

### Task 14: Docs, portfolio entry, publish

**Files:**
- Create: `docs/troubleshooting.md`, finish `README.md`
- Modify: `ibrahim-jaafar.github.io/index.html` (new project card, skills line), `ibrahim-jaafar.github.io/profile.md`, `C:\Users\ibrah\OneDrive\Desktop\personal\CV\application-notes.md`

- [ ] **Step 1: Troubleshooting guide** for a non-technical account manager: how to tell something is wrong (lights, partial badge), what each warning means and what to do, what to try first (rerun, check the service status pages), when and how to escalate (what to send: run ID, time, screenshot). Plain English, no jargon.
- [ ] **Step 2: README:** what it is, live vs simulated, setup from scratch (Tasks 9–12), how to rebuild workflows.
- [ ] **Step 3: Draft the project card, the skills change ("n8n (learning)" → "n8n"), and the profile.md entry; show each wording to Ibrahim and get approval before changing the files.**
- [ ] **Step 4: Push the portfolio repo; wait for Pages `built`; run one Random demo on the live site at phone and desktop width.**
- [ ] **Step 5: Update application-notes.md with the verified facts (what's live, what's simulated), and close/update tracker item #3.**
- [ ] **Step 6: Commit** `docs: troubleshooting guide and README`
