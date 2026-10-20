// Writes the n8n workflow templates in workflows/src/. Edit this file, not the JSON.
// IDs come from .env (none of them are secrets: credential *IDs*, GHL location and pipeline IDs).
// Usage: node scripts/make-templates.mjs && npm run build
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)
  .filter(l => l.includes('=') && !l.startsWith('#')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));

const ORIGIN = process.env.DEMO_EXTRA_ORIGIN ? 'https://ibrahim-jaafar.github.io,' + process.env.DEMO_EXTRA_ORIGIN : 'https://ibrahim-jaafar.github.io';
const GHL = 'https://services.leadconnectorhq.com';
const META_URL = `https://graph.facebook.com/v23.0/${env.META_DATASET_ID}/events`;
const AI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
// two attempts, two models: each has its own free daily quota (20 requests each), and Flash's answer wins when both are valid
const AI_MODELS = ['gemini-flash-latest', 'gemini-flash-lite-latest'];
const CLIENTS = {
  clinic: { label: 'Clinic', name: 'Lumière Skin Clinic', location: env.GHL_LOCATION_CLINIC, pipeline: env.GHL_PIPELINE_CLINIC, stage: env.GHL_STAGE_CLINIC_WON, cred: ['N8N_CRED_GHL_CLINIC', 'GHL clinic'] },
  store: { label: 'Store', name: 'Northwind Home', location: env.GHL_LOCATION_STORE, pipeline: env.GHL_PIPELINE_STORE, stage: env.GHL_STAGE_STORE_WON, cred: ['N8N_CRED_GHL_STORE', 'GHL store'] },
};
const PG = { postgres: { id: env.N8N_CRED_PG, name: 'Supabase demo' } };
const header = (key, name) => ({ httpHeaderAuth: { id: env[key], name } });

// Stable ids so re-deploys don't churn (n8n keys webhooks by webhookId).
const sid = s => { const h = createHash('sha1').update(s).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`; };
const code = (lines) => (Array.isArray(lines) ? lines.join('\n') : lines);

function workflow(name, steps) {
  const nodes = [], connections = {};
  let x = 0, prev = null;
  for (const s of steps) {
    if (s.branch) { // [fromNode, outputIndex] — start a new row from an earlier node's output
      prev = s.branch; x = s.x; continue;
    }
    const node = { id: sid(`${name}/${s.name}`), name: s.name, type: s.type, typeVersion: s.v, position: [x, s.y || 0], parameters: s.params, ...s.extra };
    nodes.push(node);
    const link = ([from, out]) => { connections[from] ??= { main: [] }; (connections[from].main[out] ??= []).push({ node: s.name, type: 'main', index: 0 }); };
    if (prev) link(Array.isArray(prev) ? prev : [prev, 0]);
    if (s.alsoFrom) link(s.alsoFrom); // a second way in, e.g. the "nothing to retry" side of an IF
    prev = s.name; x += 220;
  }
  return { name, nodes, connections, settings: { executionOrder: 'v1' } };
}

const codeNode = (name, js, y) => ({ name, y, type: 'n8n-nodes-base.code', v: 2, params: { jsCode: code(js) } });
const sql = (name, query, replacement, y, extra = {}) => ({ name, y, type: 'n8n-nodes-base.postgres', v: 2.5,
  params: { operation: 'executeQuery', query: code(query), options: replacement ? { queryReplacement: replacement } : {} }, extra: { credentials: PG, ...extra } });
// One generic HTTP node: each input item carries its own request in json.req. Errors come back as items, never stop the run.
const http = (name, creds, { headers = [], batch, timeout = 30000, y } = {}) => ({ name, y, type: 'n8n-nodes-base.httpRequest', v: 4.2,
  params: { method: '={{ $json.req.method }}', url: '={{ $json.req.url }}', authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    sendHeaders: headers.length > 0, headerParameters: { parameters: headers.map(([name, value]) => ({ name, value })) },
    sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.req.body ?? {}) }}',
    options: { timeout, response: { response: { fullResponse: true, neverError: true } }, ...(batch ? { batching: { batch: { batchSize: batch, batchInterval: 1000 } } } : {}) } },
  extra: { credentials: creds, onError: 'continueRegularOutput' } });
// Our GoHighLevel token allows 25 requests per 10 s per sub-account (its X-RateLimit headers say so; the docs say 100).
// 2 a second stays under that. GHL_BATCH=25 is only for testing the retry below.
const GHL_BATCH = Number(process.env.GHL_BATCH) || 2;
const ghlHttp = (c, what, y) => http(`GHL ${c}: ${what}`, header(...CLIENTS[c].cred), { headers: [['Version', '2021-07-28']], batch: GHL_BATCH, y });
const ifTrue = (expr, id) => ({ conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
  conditions: [{ id, leftValue: expr, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {} });
// Save to GoHighLevel; anything refused for the rate limit (429) is sent once more after a 10-second pause.
// `from` is the Code node that built the requests. The step after this needs afterSave() for the "nothing refused" path.
const ghlSave = (c, what, from, y) => {
  const n = `GHL ${c}: ${what}`;
  return [
    ghlHttp(c, what, y),
    { ...codeNode(`${n} (refused)`, [
      '// requests refused for going over the rate limit; none = one empty item (always output data), so the IF can route it',
      `const sent = $('${from}').all().map(i => i.json);`,
      'return $input.all().flatMap((it, i) => it.json.statusCode === 429 ? [{ json: { i, req: sent[i].req } }] : []);'], y), extra: { alwaysOutputData: true } },
    { name: `${n} (any refused?)`, y, type: 'n8n-nodes-base.if', v: 2, params: ifTrue('={{ !!$json.req }}', sid(`${n} refused`)) },
    { name: `${n} (pause)`, y, type: 'n8n-nodes-base.wait', v: 1.1, params: { resume: 'timeInterval', amount: 10, unit: 'seconds' }, extra: { webhookId: sid(`${n} pause`) } },
    { ...ghlHttp(c, what, y), name: `${n} (retry)` },
  ];
};
const afterSave = (step, c, what) => ({ ...step, alsoFrom: [`GHL ${c}: ${what} (any refused?)`, 1] });
// GoHighLevel's answers in request order, with retried answers put back in their place.
const ANSWERS = "const answers = n => { const r = $(n).all().map(i => i.json); if ($(`${n} (retry)`).isExecuted) { const idx = $(`${n} (refused)`).all().map(i => i.json.i); $(`${n} (retry)`).all().forEach((it, k) => { r[idx[k]] = it.json; }); } return r; };";
const GHL_TEST_FLOOD = Number(process.env.GHL_TEST_FLOOD) || 0; // ponytail: test only, extra lookups that push a run over the rate limit
const NOOP = ["// ponytail: one harmless lookup when there's nothing to save (n8n stops a branch with no items)",
  "if (!reqs.length) reqs.push({ kind: 'noop', req: { method: 'POST', url: `${G}/contacts/search`, body: { locationId: C.location, pageLimit: 1 } } });"];

const STEP_HELPERS = [
  'const setStep = (steps, key, status, reason) => steps.map(s => s.key === key ? (reason ? { key, status, reason } : { key, status }) : s);',
];

// ---------- start section (Task 11) ----------
const start = [
  { name: 'Start webhook', type: 'n8n-nodes-base.webhook', v: 2, params: { httpMethod: 'POST', path: 'demo/start', responseMode: 'responseNode', options: { allowedOrigins: ORIGIN } }, extra: { webhookId: sid('demo/start') } },
  sql('Recent runs', [
    "select coalesce(json_agg(json_build_object('id', id, 'status', status, 'created_at', created_at)), '[]'::json) as runs",
    "from demo_runs where created_at >= now() - interval '1 day'"]),
  codeNode('Decide', [
    '/*@lib*/',
    "let body = $('Start webhook').first().json.body;",
    "if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }",
    'const scenario = parseScenario(body);',
    'const limit = checkLimits($input.first().json.runs || [], new Date());',
    "const steps = ['ghl', 'spend', 'meta', 'checks', 'ai'].map(key => ({ key, status: key === 'ghl' ? 'running' : 'pending' }));",
    'return [{ json: { scenario, limit, steps } }];']),
  { name: 'Allowed?', type: 'n8n-nodes-base.if', v: 2, params: { conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
    conditions: [{ id: sid('allowed'), leftValue: '={{ $json.limit.ok }}', rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
    combinator: 'and' }, options: {} } },
];
const refuse = [
  { branch: ['Allowed?', 1], x: 880 },
  sql('Latest report', "select (select report from demo_runs where status in ('done','partial') order by created_at desc limit 1) as latest", null, 300),
  codeNode('Refusal', [
    "const { limit } = $('Decide').first().json;",
    "if (limit.reason === 'running') return [{ json: { code: 200, body: { runId: limit.runId, joined: true } } }];",
    'return [{ json: { code: 429, body: { reason: limit.reason, retryAfterSec: limit.retryAfterSec, latest: $input.first().json.latest ?? null } } }];'], 300),
  { name: 'Respond refused', y: 300, type: 'n8n-nodes-base.respondToWebhook', v: 1.1, params: { respondWith: 'json', responseBody: '={{ JSON.stringify($json.body) }}', options: { responseCode: '={{ $json.code }}' } } },
];

// ---------- the run (Task 12) ----------
const contactsCode = c => [
  `// ${CLIENTS[c].name}: save this run's leads.`,
  "const plan = $('Plan run').first().json;",
  `const C = ${JSON.stringify({ location: CLIENTS[c].location })};`,
  `const G = '${GHL}';`,
  'const reqs = [];',
  `for (const l of plan.leads.${c}) {`,
  "  const body = { locationId: C.location, firstName: l.firstName, lastName: l.lastName, email: l.email, phone: l.phone,",
  "    tags: ['demo', `run:${plan.runId}`, `created:${Date.parse(l.createdAt)}`] };",
  '  if (l.source) body.source = l.source;',
  "  reqs.push({ kind: 'contact', leadId: l.id, req: { method: 'POST', url: `${G}/contacts/`, body } });",
  '}',
  ...NOOP,
  ...(GHL_TEST_FLOOD ? [`for (let i = 0; i < ${GHL_TEST_FLOOD}; i++) reqs.unshift({ kind: 'noop', req: { method: 'POST', url: \`\${G}/contacts/search\`, body: { locationId: C.location, pageLimit: 1 } } });`] : []),
  'return reqs.map(json => ({ json }));',
];
const dealsCode = c => [
  `// ${CLIENTS[c].name}: a deal for each booked/cancelled lead.`,
  "const plan = $('Plan run').first().json;",
  `const C = ${JSON.stringify({ location: CLIENTS[c].location, pipeline: CLIENTS[c].pipeline, stage: CLIENTS[c].stage })};`,
  `const G = '${GHL}';`,
  `const sent = $('${CLIENTS[c].label}: contacts').all().map(i => i.json);`,
  ANSWERS,
  `const got = answers('GHL ${c}: save contacts');`,
  'const reqs = [];',
  'sent.forEach((s, i) => {',
  '  const r = got[i] || {};',
  "  if (s.kind === 'contact' && r.statusCode < 300 && r.body?.contact) {",
  `    const lead = plan.leads.${c}.find(l => l.id === s.leadId);`,
  "    if (lead.outcome === 'open') return;",
  "    reqs.push({ kind: 'deal', contactId: r.body.contact.id, req: { method: 'POST', url: `${G}/opportunities/`, body: {",
  `      locationId: C.location, pipelineId: C.pipeline, pipelineStageId: C.stage, contactId: r.body.contact.id,`,
  `      name: \`\${lead.firstName} \${lead.lastName} – ${c === 'clinic' ? 'consultation' : 'order'}\`, status: lead.outcome === 'converted' ? 'won' : 'lost', monetaryValue: lead.value } } });`,
  '  }',
  '});',
  ...NOOP,
  'return reqs.map(json => ({ json }));',
];

const AI_SYSTEM = [
  "You write the weekly results summary that a marketing agency's account manager reads before sending reports to two clients.",
  'Use plain, friendly English. Never type a digit. Wherever a number goes, write a placeholder from that client\'s "placeholders" list in curly braces, exactly as named, for example {costPerLead}.',
  'Code replaces each placeholder with the value listed next to it, so you can see what the reader will see. Never calculate new numbers.',
  'Use only the placeholders of the client you are writing about. The overview covers both clients and has no numbers or placeholders.',
  'Placeholders ending in _change already say which way it went (for example "up 5%" or "down 33%"): write "leads were {leads_change} on the previous report", never "leads rose {leads_change}".',
  'Outside the curly braces, never write field names such as costPerLead or paidLeads; say "cost per lead" or "paid leads". The data covers last week (Monday to Sunday).',
  'Changes compare with the previous report, not with an earlier week: call it "the previous report", never "the previous week" or "the week before".',
  'Keep each summary to two or three sentences: say what matters most this week and why, using only the few numbers that support it. Do not list every number; the report shows them all in a table.',
  'Explain every warning in client-friendly words, and suggest at most three practical next steps per client.',
  'Stay inside the length limits, counted after the placeholders are filled in: overview one sentence under 200 characters, headline under 90, summary under 600, each warning under 300, each next step under 200.',
  "Return JSON that matches the schema exactly. 'clinic' is the clinic, 'store' is the store.",
].join(' ');

const run = [
  { branch: ['Allowed?', 0], x: 880 },
  sql('Create run', "insert into demo_runs (status, scenario, steps) values ('running', $1::jsonb, $2::jsonb) returning id",
    '={{ [JSON.stringify($json.scenario), JSON.stringify($json.steps)] }}', -300),
  { name: 'Respond started', y: -300, type: 'n8n-nodes-base.respondToWebhook', v: 1.1, params: { respondWith: 'json', responseBody: '={{ JSON.stringify({ runId: $json.id, joined: false }) }}', options: {} } },
  codeNode('Plan run', [
    '/*@lib*/',
    "// The visitor already has their runId; everything below runs while the page polls the status webhook.",
    "const runId = $('Create run').first().json.id;",
    "const { scenario } = $('Decide').first().json;",
    'const seed = parseInt(runId.replace(/-/g, \'\').slice(0, 8), 16);',
    'const rng = makeRng(seed);',
    '// last full week (Monday to Monday, UTC): a weekly report covers a finished week, and no lead is dated in the future',
    'const now = new Date();',
    'const weekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ((now.getUTCDay() + 6) % 7) - 7));',
    'const problems = resolveProblems(scenario, rng);',
    "const leads = { clinic: generateLeads('clinic', problems, rng, weekStart), store: generateLeads('store', problems, rng, weekStart) };",
    'return [{ json: { runId, seed, problems, weekStart: weekStart.toISOString(), leads } }];'], -300),
  codeNode('Clinic: contacts', contactsCode('clinic'), -300),
  ...ghlSave('clinic', 'save contacts', 'Clinic: contacts', -300),
  afterSave(codeNode('Store: contacts', contactsCode('store'), -300), 'clinic', 'save contacts'),
  ...ghlSave('store', 'save contacts', 'Store: contacts', -300),
  afterSave(codeNode('Clinic: deals', dealsCode('clinic'), -300), 'store', 'save contacts'),
  ...ghlSave('clinic', 'save deals', 'Clinic: deals', -300),
  afterSave(codeNode('Store: deals', dealsCode('store'), -300), 'clinic', 'save deals'),
  ...ghlSave('store', 'save deals', 'Store: deals', -300),
  afterSave(codeNode('CRM data', [
    '/*@lib*/',
    ...STEP_HELPERS,
    ANSWERS,
    "// The report uses what GoHighLevel saved and sent back, not what was generated.",
    "const plan = $('Plan run').first().json;",
    "const crypto = require('crypto');",
    "const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');",
    'const nowSec = Math.floor(Date.now() / 1000);',
    'const rng = makeRng(plan.seed + 1);',
    "let steps = $('Decide').first().json.steps;",
    'const ghlNotes = [], out = {};',
    `const NAMES = ${JSON.stringify({ clinic: [CLIENTS.clinic.label, CLIENTS.clinic.name], store: [CLIENTS.store.label, CLIENTS.store.name] })};`,
    "let ghlStatus = 'done';",
    'for (const [client, [label, name]] of Object.entries(NAMES)) {',
    "  const pair = (a, b) => { const x = $(a).all().map(i => i.json), y = answers(b); return x.map((s, i) => [s, y[i] || {}]); };",
    "  const contacts = [], deals = new Map(); let total = 0, failed = 0;",
    "  for (const [s, r] of pair(`${label}: contacts`, `GHL ${client}: save contacts`)) {",
    "    if (s.kind !== 'contact') continue;",
    '    total++;',
    '    if (r.statusCode < 300 && r.body?.contact) contacts.push(r.body.contact); else failed++;',
    '  }',
    "  for (const [s, r] of pair(`${label}: deals`, `GHL ${client}: save deals`)) {",
    "    if (s.kind !== 'deal') continue;",
    '    total++;',
    '    if (r.statusCode < 300 && r.body?.opportunity) deals.set(s.contactId, r.body.opportunity); else failed++;',
    '  }',
    '  const leads = contacts.map(c => {',
    "    const d = deals.get(c.id), created = (c.tags || []).find(t => t.startsWith('created:'));",
    "    return { id: c.id, firstName: c.firstName ?? '', lastName: c.lastName ?? '', email: c.email ?? '', phone: c.phone ?? '', source: c.source ?? null,",
    "      createdAt: new Date(created ? +created.slice(8) : Date.parse(c.dateAdded)).toISOString(),",
    "      outcome: !d ? 'open' : d.status === 'won' ? 'converted' : 'cancelled', value: d ? Number(d.monetaryValue) || 0 : 0, flags: [] };",
    '  });',
    "  if (total && failed === total) { ghlStatus = 'failed'; ghlNotes.push(`${name}: GoHighLevel did not accept the data`); }",
    "  else if (failed) { if (ghlStatus === 'done') ghlStatus = 'warning'; ghlNotes.push(`${name}: ${failed} of ${total} records could not be saved`); }",
    '  const spend = simulateSpend(client, leads, plan.problems, rng);',
    '  const meta = buildMetaEvents(client, leads, plan.problems, nowSec, sha256);',
    '  out[client] = { client, name, leads, spend, ...meta };',
    '}',
    "steps = setStep(steps, 'ghl', ghlStatus, ghlNotes.join('; ') || undefined);",
    "steps = setStep(steps, 'spend', 'done');",
    "steps = setStep(steps, 'meta', 'running');",
    'return [{ json: { runId: plan.runId, problems: plan.problems, weekStart: plan.weekStart, clients: out, steps } }];'], -300), 'store', 'save deals'),
  sql('Save progress 1', [
    '-- show the visitor the CRM step is done; also fetch the last finished report to compare against',
    'with u as (update demo_runs set steps = $2::jsonb where id = $1::uuid)',
    "select (select report from demo_runs where status in ('done','partial') and id <> $1::uuid order by created_at desc limit 1) as prev"],
    '={{ [$json.runId, JSON.stringify($json.steps)] }}', -300),
  codeNode('Meta requests', [
    "const { clients } = $('CRM data').first().json;",
    `const body = data => ({ data, test_event_code: '${env.META_TEST_EVENT_CODE}' });`,
    'const reqs = [];',
    'for (const c of Object.values(clients)) {',
    "  // ponytail: always one request per client, even with no events (Meta then answers 400; counted as 0 sent)",
    `  reqs.push({ client: c.client, kind: 'main', count: c.events.length, req: { method: 'POST', url: '${META_URL}', body: body(c.events) } });`,
    "  // the deliberately too-old event goes alone, so Meta's rejection can't sink the real batch",
    `  if (c.edgeEvents.length) reqs.push({ client: c.client, kind: 'edge', count: c.edgeEvents.length, req: { method: 'POST', url: '${META_URL}', body: body(c.edgeEvents) } });`,
    '}',
    'return reqs.map(json => ({ json }));'], -300),
  http('Meta: send conversions', header('N8N_CRED_META', 'Meta CAPI'), { y: -300 }),
  codeNode('Checks', [
    '/*@lib*/',
    ...STEP_HELPERS,
    "const crm = $('CRM data').first().json;",
    "const prev = $('Save progress 1').first().json.prev;",
    "const sent = $('Meta requests').all().map(i => i.json), got = $('Meta: send conversions').all().map(i => i.json);",
    'let steps = crm.steps, metaFailed = [];',
    'const clients = Object.values(crm.clients).map(c => {',
    '  let meta = { sent: 0, accepted: 0, rejected: 0 };',
    '  sent.forEach((s, i) => {',
    '    if (s.client !== c.client || !s.count) return;',
    '    const r = got[i] || {};',
    '    meta.sent += s.count;',
    "    if (s.kind === 'main' && r.statusCode !== 200) { metaFailed.push(`${c.name}: Meta answered ${r.statusCode ?? 'nothing'}`); meta = null; return; }",
    '    if (!meta) return;',
    "    const ok = r.statusCode === 200 ? Number(r.body?.events_received) || 0 : 0;",
    "    if (s.kind === 'main') meta.accepted += ok;",
    '    meta.rejected += s.count - ok;',
    '  });',
    '  const weekStart = new Date(crm.weekStart);',
    '  const kpis = computeKpis(c.client, c.leads, c.spend, weekStart);',
    '  const warnings = runChecks({ client: c.client, leads: c.leads, spend: c.spend, meta, weekStart });',
    '  const previousKpis = prev?.clients?.find(p => p.client === c.client)?.kpis ?? null;',
    '  return { client: c.client, name: c.name, kpis, previousKpis, warnings, skipped: c.skipped };',
    '});',
    "steps = setStep(steps, 'meta', metaFailed.length ? 'failed' : 'done', metaFailed.join('; ') || undefined);",
    "steps = setStep(steps, 'checks', 'done');",
    "steps = setStep(steps, 'ai', 'running');",
    'const aiInput = buildAiInput(clients);',
    `const aiBody = { messages: [{ role: 'system', content: ${JSON.stringify(AI_SYSTEM)} }, { role: 'user', content: JSON.stringify(aiInput) }],`,
    "  response_format: { type: 'json_schema', json_schema: { name: 'weekly_report', strict: true, schema: AI_SCHEMA } } };",
    'return [{ json: { ...crm, clients, aiInput, aiBody, steps } }];'], -300),
  sql('Save progress 2', [
    '-- show the visitor the checks are done; two rows = two AI attempts in parallel (the first valid answer wins)',
    'with u as (update demo_runs set steps = $2::jsonb where id = $1::uuid)',
    'select attempt from generate_series(1, 2) as attempt'],
    '={{ [$json.runId, JSON.stringify($json.steps)] }}', -300),
  { name: 'AI: write summary', y: -300, type: 'n8n-nodes-base.httpRequest', v: 4.2,
    params: { method: 'POST', url: AI_URL, authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
      sendBody: true, specifyBody: 'json', jsonBody: `={{ JSON.stringify({ model: ${JSON.stringify(AI_MODELS)}[$json.attempt - 1], ...$('Checks').first().json.aiBody }) }}`,
      options: { timeout: 60000, response: { response: { fullResponse: true, neverError: true } } } },
    extra: { credentials: header('N8N_CRED_GEMINI', 'Gemini'), onError: 'continueRegularOutput' } },
  codeNode('Build report', [
    '/*@lib*/',
    ...STEP_HELPERS,
    "const ck = $('Checks').first().json;",
    "const replies = $('AI: write summary').all().map(i => i.json);",
    'let ai = null, gotAnswer = false; const errors = [];',
    'for (const r of replies) {',
    '  let raw = r.statusCode === 200 ? r.body?.choices?.[0]?.message?.content : null;',
    "  if (raw != null && ck.problems.includes('ai_broken')) raw = \"Sorry, I can't help with that.\";",
    "  if (raw == null) { errors.push(`AI service answered ${r.statusCode ?? 'nothing'}`); continue; }",
    '  gotAnswer = true;',
    '  const v = validateAiOutput(raw, ck.aiInput);',
    "  if (v.ok) { ai = { source: 'ai', value: v.value }; break; }",
    '  errors.push(...v.errors);',
    '}',
    "let steps = ck.steps;",
    "if (ai) steps = setStep(steps, 'ai', 'done');",
    'else {',
    "  ai = { source: 'template', value: templateSummary(ck.aiInput) };",
    "  steps = gotAnswer ? setStep(steps, 'ai', 'warning', `AI answer rejected (${errors[0]}); template summary used`)",
    "    : setStep(steps, 'ai', 'failed', `${errors[0] || 'no AI answer'}; template summary used`);",
    '}',
    'const metaSkipped = ck.clients.reduce((a, c) => a + c.skipped, 0);',
    'const report = buildReport({ runId: ck.runId, weekStart: ck.weekStart, clients: ck.clients, steps, ai, problems: ck.problems, metaSkipped });',
    "return [{ json: { runId: ck.runId, status: report.partial ? 'partial' : 'done', report, steps } }];"], -300),
  sql('Save result', 'update demo_runs set status = $2, report = $3::jsonb, steps = $4::jsonb where id = $1::uuid returning id',
    '={{ [$json.runId, $json.status, JSON.stringify($json.report), JSON.stringify($json.steps)] }}', -300),
];

// ---------- cleanup: after the report is saved, delete demo contacts older than 7 days (GoHighLevel removes their deals too) ----------
// Here and not on a schedule: the free server sleeps, so a nightly job wouldn't fire. The visitor already has the report.
const CLEANUP_HOURS = Number(process.env.CLEANUP_HOURS) || 7 * 24; // ponytail: the env override is only for testing
const CLEANUP_MAX = 25; // per client per run: more than a run creates, and about 13 s at 2 a second
const cleanup = (c, y) => {
  const L = CLIENTS[c].label;
  return [
    { branch: ['Save result', 0], x: 880 },
    codeNode(`${L}: find old contacts`, [
      `// the oldest demo contacts in ${CLIENTS[c].name} older than ${CLEANUP_HOURS} hours`,
      `return [{ json: { req: { method: 'POST', url: '${GHL}/contacts/search', body: { locationId: '${CLIENTS[c].location}', pageLimit: ${CLEANUP_MAX},`,
      "  filters: [{ field: 'tags', operator: 'eq', value: 'demo' },",
      `    { field: 'dateAdded', operator: 'range', value: { lt: new Date(Date.now() - ${CLEANUP_HOURS} * 36e5).toISOString() } }],`,
      "  sort: [{ field: 'dateAdded', direction: 'asc' }] } } } }];"], y),
    ghlHttp(c, 'find old contacts', y),
    codeNode(`${L}: old contacts`, [
      '// one delete per contact found; none found = no items, and the branch just ends',
      `const cutoff = Date.now() - ${CLEANUP_HOURS} * 36e5;`,
      'const r = $input.first().json;',
      "const old = r.statusCode === 200 ? (r.body?.contacts || []).filter(c => Date.parse(c.dateAdded) < cutoff) : [];",
      `return old.slice(0, ${CLEANUP_MAX}).map(c => ({ json: { req: { method: 'DELETE', url: '${GHL}/contacts/' + c.id } } }));`], y),
    ghlHttp(c, 'delete old contacts', y),
  ];
};

const demoRun = workflow('demo-run', [...start, ...refuse, ...run, ...cleanup('clinic', 600), ...cleanup('store', 800)]);

const demoStatus = workflow('demo-status', [
  { name: 'Status webhook', type: 'n8n-nodes-base.webhook', v: 2, params: { httpMethod: 'GET', path: 'demo/status', responseMode: 'lastNode', options: { allowedOrigins: ORIGIN } }, extra: { webhookId: sid('demo/status') } },
  // The asked-for run if it exists, else the latest finished one. The id is a query parameter, compared as text.
  sql('Find run', [
    'select id as "runId", status, steps, report from (',
    '  select 0 as pick, id, status, steps, report from demo_runs where id::text = lower($1)',
    '  union all',
    "  (select 1, id, status, steps, report from demo_runs where status in ('done','partial') order by created_at desc limit 1)",
    ') r order by pick limit 1'], "={{ [String($json.query.run ?? '').slice(0, 36)] }}", 0, { alwaysOutputData: true }),
]);

// Any crash in demo-run marks the running run failed, so the page never waits forever.
const errorHandler = workflow('error-handler', [
  { name: 'On error', type: 'n8n-nodes-base.errorTrigger', v: 1, params: {} },
  sql('Mark run failed', "update demo_runs set status = 'failed', error = $1 where status = 'running' returning id",
    "={{ [String($json.execution?.error?.message ?? 'unknown error').slice(0, 500) + ' (node: ' + ($json.execution?.lastNodeExecuted ?? '?') + ')'] }}"),
]);

for (const wf of [demoRun, demoStatus, errorHandler]) writeFileSync(new URL(`../workflows/src/${wf.name}.json`, import.meta.url), JSON.stringify(wf, null, 2) + '\n');
console.log('templates written');
