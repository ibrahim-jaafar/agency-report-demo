// Writes the n8n workflow templates in workflows/src/. Edit this file, not the JSON.
// IDs come from .env (none of them are secrets: credential *IDs*, GHL location and pipeline IDs).
// Usage: node scripts/make-templates.mjs && npm run build
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { placeholderGuide } from '../lib/ai.js';

const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)
  .filter(l => l.includes('=') && !l.startsWith('#')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));

const ORIGIN = process.env.DEMO_EXTRA_ORIGIN ? 'https://ibrahim-jaafar.github.io,' + process.env.DEMO_EXTRA_ORIGIN : 'https://ibrahim-jaafar.github.io';
const GHL = 'https://services.leadconnectorhq.com';
const META_URL = `https://graph.facebook.com/v23.0/${env.META_DATASET_ID}/events`;
const AI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
// Flash-Lite first: on the free tier it answers in seconds, while Flash often takes over a minute or is overloaded (measured 2026-10-20).
// Flash is asked only when Lite's answer fails; each has its own free quota of 20 requests a day.
const AI_MODELS = { first: 'gemini-flash-lite-latest', second: 'gemini-flash-latest' };
const aiNode = (name, model, from) => ({ name, y: 0, type: 'n8n-nodes-base.httpRequest', v: 4.2,
  params: { method: 'POST', url: AI_URL, authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    sendBody: true, specifyBody: 'json', jsonBody: `={{ JSON.stringify({ model: '${model}', ...$('${from}').first().json.aiBody }) }}`,
    options: { timeout: 45000, response: { response: { fullResponse: true, neverError: true } } } },
  extra: { credentials: header('N8N_CRED_GEMINI', 'Gemini'), onError: 'continueRegularOutput' } });
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
    // more ways in, e.g. the "nothing to retry" side of an IF: [node, output] or a list of them
    if (s.alsoFrom) (Array.isArray(s.alsoFrom[0]) ? s.alsoFrom : [s.alsoFrom]).forEach(link);
    prev = s.name; x += 220;
  }
  return { name, nodes, connections, settings: { executionOrder: 'v1' } };
}

const codeNode = (name, js, y) => ({ name, y, type: 'n8n-nodes-base.code', v: 2, params: { jsCode: code(js) } });
const sql = (name, query, replacement, y, extra = {}) => ({ name, y, type: 'n8n-nodes-base.postgres', v: 2.5,
  params: { operation: 'executeQuery', query: code(query), options: replacement ? { queryReplacement: replacement } : {} }, extra: { credentials: PG, ...extra } });
// One generic HTTP node: each input item carries its own request in json.req. Errors come back as items, never stop the run.
const http = (name, creds, { headers = [], batch, timeout = 30000, paging, y } = {}) => ({ name, y, type: 'n8n-nodes-base.httpRequest', v: 4.2,
  params: { method: '={{ $json.req.method }}', url: '={{ $json.req.url }}', authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    sendHeaders: headers.length > 0, headerParameters: { parameters: headers.map(([name, value]) => ({ name, value })) },
    sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.req.body ?? {}) }}',
    options: { timeout, response: { response: { fullResponse: true, neverError: true } }, ...(batch ? { batching: { batch: { batchSize: batch, batchInterval: 1000 } } } : {}),
      ...(paging ? { pagination: { pagination: paging } } : {}) } },
  extra: { credentials: creds, onError: 'continueRegularOutput' } });
// Our GoHighLevel token allows 25 requests per 10 s per sub-account (its X-RateLimit headers say so; the docs say 100).
// 2 a second stays under that. GHL_BATCH=25 is only for testing the retry below.
const GHL_BATCH = Number(process.env.GHL_BATCH) || 2;
// Reads page through long lists (n8n's own paging; each page comes out as its own item, tagged with its request).
// Contacts take a page number in the body, deals a cursor from the last reply's meta; each side ignores the other's.
// Stops on an error, a short page, or (deals, newest first) a page that reaches back before the report's week.
// GHL_PAGE (default 100, GoHighLevel's most) is smaller only to test paging with the demo's few leads.
const PAGE = Number(process.env.GHL_PAGE) || 100, MAX_PAGES = 100;
const READ_PAGING = { paginationMode: 'updateAParameterInEachRequest', parameters: { parameters: [
    { type: 'body', name: 'page', value: '={{ $pageCount + 1 }}' },
    { type: 'qs', name: 'startAfter', value: '={{ $response.body.meta?.startAfter }}' },
    { type: 'qs', name: 'startAfterId', value: '={{ $response.body.meta?.startAfterId }}' }] },
  paginationCompleteWhen: 'other',
  completeExpression: `={{ $response.statusCode !== 200 || ($response.body.contacts ?? $response.body.opportunities ?? []).length < ${PAGE} || Date.parse($response.body.opportunities?.at(-1)?.createdAt) < ($json.stopBefore ?? 0) }}`,
  // the two reads page side by side, so 1 s each keeps us at 2 requests a second (GHL_BATCH=25 speeds this up too, to test the retry)
  limitPagesFetched: true, maxRequests: MAX_PAGES, requestInterval: Math.round(2000 / GHL_BATCH) };
const ghlHttp = (c, what, y) => http(`GHL ${c}: ${what}`, header(...CLIENTS[c].cred), { headers: [['Version', '2021-07-28']], batch: GHL_BATCH, paging: what === 'read' ? READ_PAGING : undefined, y });
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
      '// pairedItem says which request a reply answers (a paged read gives several replies per request)',
      `const sent = $('${from}').all().map(i => i.json);`,
      'const seen = new Set();',
      'return $input.all().flatMap((it, k) => { const i = it.pairedItem?.item ?? k; if (it.json.statusCode !== 429 || seen.has(i)) return []; seen.add(i); return [{ json: { ...sent[i], i } }]; });'], y), extra: { alwaysOutputData: true } },
    { name: `${n} (any refused?)`, y, type: 'n8n-nodes-base.if', v: 2, params: ifTrue('={{ !!$json.req }}', sid(`${n} refused`)) },
    { name: `${n} (pause)`, y, type: 'n8n-nodes-base.wait', v: 1.1, params: { resume: 'timeInterval', amount: 10, unit: 'seconds' }, extra: { webhookId: sid(`${n} pause`) } },
    { ...ghlHttp(c, what, y), name: `${n} (retry)` },
  ];
};
const afterSave = (step, c, what) => ({ ...step, alsoFrom: [`GHL ${c}: ${what} (any refused?)`, 1] });
// GoHighLevel's answers in request order, with retried answers put back in their place.
const ANSWERS = "const answers = n => { const r = $(n).all().map(i => i.json); if ($(`${n} (retry)`).isExecuted) { const idx = $(`${n} (refused)`).all().map(i => i.json.i); $(`${n} (retry)`).all().forEach((it, k) => { r[idx[k]] = it.json; }); } return r; };";
// The same for a paged read: every request's pages, in request order, with a retried request's pages put in its place.
const PAGES = "const pages = n => { const r = [], put = (items, at) => items.forEach((it, k) => (r[at(it.pairedItem?.item ?? k)] ??= []).push(it.json)); put($(n).all(), i => i); if ($(`${n} (retry)`).isExecuted) { const idx = $(`${n} (refused)`).all().map(i => i.json.i); idx.forEach(i => { r[i] = []; }); put($(`${n} (retry)`).all(), k => idx[k]); } return r; };";
const GHL_TEST_FLOOD = Number(process.env.GHL_TEST_FLOOD) || 0; // ponytail: test only, extra lookups that push a run over the rate limit
const NOOP = ["// ponytail: one harmless lookup when there's nothing to save (n8n stops a branch with no items)",
  "if (!reqs.length) reqs.push({ kind: 'noop', req: { method: 'POST', url: `${G}/contacts/search`, body: { locationId: C.location, pageLimit: 1 } } });"];

const NAMES = `const NAMES = ${JSON.stringify({ clinic: [CLIENTS.clinic.label, CLIENTS.clinic.name], store: [CLIENTS.store.label, CLIENTS.store.name] })};`;
// deploy.mjs puts in the report workflow's real id (n8n only gives one once it exists)
const REPORT_ID = 'weekly-report';
// The report reads again, 5 s apart, while search finds fewer of the run's contacts than were saved; at most READ_TRIES reads.
const READ_TRIES = 6;

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
    "const steps = ['ghl', 'spend', 'meta', 'checks'].map(key => ({ key, status: key === 'ghl' ? 'running' : 'pending' }));",
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

// Slack alerts, built only once the Slack bot credential exists in n8n (N8N_CRED_SLACK and SLACK_CHANNEL in .env).
// The bot token stays in that credential; a failed Slack post never stops a report (onError: continue).
for (const k of ['N8N_CRED_SLACK', 'SLACK_CHANNEL']) env[k] ??= process.env[k]; // ponytail: env override only to test the build
const SLACK = !!(env.N8N_CRED_SLACK && env.SLACK_CHANNEL);
const slackReq = textVar => `{ method: 'POST', url: 'https://slack.com/api/chat.postMessage', body: { channel: '${env.SLACK_CHANNEL}', text: ${textVar} } }`;
const slackSend = y => http('Slack: send', header('N8N_CRED_SLACK', 'Slack bot'), { headers: [['Content-Type', 'application/json; charset=utf-8']], y });

// How many of this run's contacts each client's search finds; checked every 5 s, at most CATCH_UP_TRIES times.
const CATCH_UP_TRIES = 12;
const countReq = c => `{ method: 'POST', url: '${GHL}/contacts/search', body: { locationId: '${CLIENTS[c].location}', pageLimit: 1, filters: [{ field: 'tags', operator: 'eq', value: $('Hand over').first().json.select.tag }] } }`;
const catchUp = [
  { ...codeNode('Clinic: count', [`return [{ json: { req: ${countReq('clinic')} } }];`], -300), alsoFrom: ['Look again soon', 0] },
  ghlHttp('clinic', 'count', -300),
  codeNode('Store: count', [`return [{ json: { clinicFound: $json.body?.total ?? 0, req: ${countReq('store')} } }];`], -300),
  ghlHttp('store', 'count', -300),
  { name: 'All searchable?', y: -300, type: 'n8n-nodes-base.if', v: 2, params: ifTrue(
    `={{ ($('Store: count').item.json.clinicFound >= $('Hand over').first().json.saved.clinic && ($json.body?.total ?? 0) >= $('Hand over').first().json.saved.store) || $runIndex >= ${CATCH_UP_TRIES - 1} }}`, sid('all searchable')) },
  // ponytail: after the last try the report runs anyway and shows what search found
  codeNode('Pass it on', ["return [{ json: $('Hand over').first().json }];"], -300),
];
const catchUpLoop = [
  { branch: ['All searchable?', 1], x: 7920 },
  { name: 'Look again soon', y: -100, type: 'n8n-nodes-base.wait', v: 1.1, params: { resume: 'timeInterval', amount: 5, unit: 'seconds' }, extra: { webhookId: sid('look again') } },
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
  "You write the results summary that a marketing agency's account manager reads before sending reports to two clients.",
  'Use plain, friendly English. Never type a digit. Wherever a number goes, write a placeholder from that client\'s "placeholders" list in curly braces, exactly as named, for example {costPerLead}.',
  'Code replaces each placeholder with the value listed next to it, so you can see what the reader will see. Never calculate new numbers.',
  'Use only the placeholders of the client you are writing about. The overview covers both clients and has no numbers or placeholders.',
  'Placeholders ending in _change already say which way it went (for example "up 5%" or "down 33%"): write "leads were {leads_change} compared with <period.vs>", never "leads rose {leads_change}".',
  'Outside the curly braces, never write field names such as costPerLead or paidLeads; say "cost per lead" or "paid leads".',
  'The input\'s "period" says what the data covers ("covers", for example "this month so far") and what every change compares with ("vs"): use exactly those words for them and never name any other time (no "last week" or "last month" unless that is what they say).',
  'The value next to each placeholder is what the reader sees, so the word after a count must agree with it: "{orders} order" only when the value is 1, "{orders} orders" for any other value.',
  'When period.finished is false the period is still under way: say "so far".',
  'Keep each summary to two or three sentences: say what matters most in this period and why, using only the few numbers that support it. Do not list every number; the dashboard shows them all.',
  'Write one item per warning: start it with that warning\'s {<code>_message} placeholder (the check\'s own sentence, numbers included), then add one short sentence in client-friendly words on what it means, with no numbers. For example "{duplicates_message} Some people filled in the form twice, so the lead count looks better than it is."',
  'Never retype a number from a warning\'s message; the placeholder shows it. Suggest at most three practical next steps per client.',
  placeholderGuide(),
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
    "// the last 7 days up to now (UTC): today so far and the 6 days before. Meta takes conversions up to 7 days old,",
    '// and no lead is dated in the future',
    'const now = new Date();',
    'const weekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 6));',
    'const problems = resolveProblems(scenario, rng);',
    "const leads = { clinic: generateLeads('clinic', problems, rng, weekStart, +now), store: generateLeads('store', problems, rng, weekStart, +now) };",
    'return [{ json: { runId, seed, problems, weekStart: weekStart.toISOString(), ranAt: now.toISOString(), leads } }];'], -300),
  codeNode('Clinic: contacts', contactsCode('clinic'), -300),
  ...ghlSave('clinic', 'save contacts', 'Clinic: contacts', -300),
  afterSave(codeNode('Store: contacts', contactsCode('store'), -300), 'clinic', 'save contacts'),
  ...ghlSave('store', 'save contacts', 'Store: contacts', -300),
  afterSave(codeNode('Clinic: deals', dealsCode('clinic'), -300), 'store', 'save contacts'),
  ...ghlSave('clinic', 'save deals', 'Clinic: deals', -300),
  afterSave(codeNode('Store: deals', dealsCode('store'), -300), 'clinic', 'save deals'),
  ...ghlSave('store', 'save deals', 'Store: deals', -300),
  afterSave(codeNode('Hand over', [
    '/*@lib*/',
    ...STEP_HELPERS,
    ANSWERS,
    "// The fake customers are in GoHighLevel now. Note what it refused, then hand over to the weekly report,",
    "// which reads GoHighLevel the way it would for a real client.",
    "const plan = $('Plan run').first().json;",
    'const rng = makeRng(plan.seed + 1);',
    "let steps = $('Decide').first().json.steps;",
    NAMES,
    "let ghlStatus = 'done'; const ghlNotes = [], spend = {}, saved = {}, savedDeals = {};",
    'for (const [client, [label, name]] of Object.entries(NAMES)) {',
    "  const pair = (a, b) => { const x = $(a).all().map(i => i.json), y = answers(b); return x.map((s, i) => [s, y[i] || {}]); };",
    '  let total = 0, failed = 0;',
    "  saved[client] = 0; savedDeals[client] = 0;",
    "  for (const [s, r] of pair(`${label}: contacts`, `GHL ${client}: save contacts`)) { if (s.kind !== 'contact') continue; total++; if (!(r.statusCode < 300 && r.body?.contact)) failed++; else saved[client]++; }",
    "  for (const [s, r] of pair(`${label}: deals`, `GHL ${client}: save deals`)) { if (s.kind !== 'deal') continue; total++; if (!(r.statusCode < 300 && r.body?.opportunity)) failed++; else savedDeals[client]++; }",
    "  if (total && failed === total) { ghlStatus = 'failed'; ghlNotes.push(`${name}: GoHighLevel did not accept the data`); }",
    "  else if (failed) { if (ghlStatus === 'done') ghlStatus = 'warning'; ghlNotes.push(`${name}: ${failed} of ${total} records could not be saved`); }",
    "  // stands in for the ad platform's spend report (Meta's Insights API for a real client)",
    '  spend[client] = simulateSpend(client, plan.leads[client], plan.problems, rng);',
    '}',
    "steps = setStep(steps, 'ghl', ghlStatus, ghlNotes.join('; ') || undefined);",
    "// problems: the mistakes the visitor picked (empty for a real client). select: which contacts belong to this report.",
    "return [{ json: { runId: plan.runId, problems: plan.problems, weekStart: plan.weekStart, ranAt: plan.ranAt, steps, spend, select: { tag: `run:${plan.runId}` }, saved, savedDeals } }];"], -300), 'store', 'save deals'),
  // GoHighLevel's search finds new contacts only some time after they're saved (seen: 0 of 6 found 20 s later).
  // So wait until search finds every contact this run saved, then hand over. Only the demo needs this: a real report runs days later.
  ...catchUp,
  // waits for the report, so the cleanup below never deletes contacts the report is still reading
  { name: 'Run the weekly report', y: -300, type: 'n8n-nodes-base.executeWorkflow', v: 1.2, params: { source: 'database',
    workflowId: { __rl: true, mode: 'id', value: REPORT_ID }, mode: 'once',
    workflowInputs: { mappingMode: 'defineBelow', value: {}, matchingColumns: [], schema: [], attemptToConvertTypes: false, convertFieldsToString: true },
    options: { waitForSubWorkflow: true } } },
];

// ---------- the weekly report: the part a real client gets. It only reads GoHighLevel; it doesn't know the data is fake ----------
const readCode = c => [
  `// ${CLIENTS[c].name}: this report's contacts, and the newest deals in its pipeline (matched to those contacts next).`,
  "const job = $('Start report').first().json;",
  `const G = '${GHL}', L = '${CLIENTS[c].location}', P = '${CLIENTS[c].pipeline}';`,
  'return [',
  // ponytail: test only, lookups ahead of the reads so the reads get refused and retried
  ...(GHL_TEST_FLOOD ? [`  ...Array.from({ length: ${GHL_TEST_FLOOD} }, () => ({ json: { kind: 'noop', req: { method: 'POST', url: \`\${G}/contacts/search\`, body: { locationId: L, pageLimit: 1 } } } })),`] : []),
  `  { json: { kind: 'contacts', req: { method: 'POST', url: \`\${G}/contacts/search\`, body: { locationId: L, page: 1, pageLimit: ${PAGE}, filters: [{ field: 'tags', operator: 'eq', value: job.select.tag }] } } } },`,
  "  // newest first; a deal is never older than its contact, so paging stops once it reaches back before the week",
  `  { json: { kind: 'deals', stopBefore: Date.parse(job.weekStart), req: { method: 'GET', url: \`\${G}/opportunities/search?location_id=\${L}&pipeline_id=\${P}&limit=${PAGE}\` } } },`,
  '];',
];

const report = [
  { name: 'Start report', y: -300, type: 'n8n-nodes-base.executeWorkflowTrigger', v: 1.1, params: { inputSource: 'passthrough' } },
  { ...codeNode('Clinic: read', readCode('clinic'), -300), alsoFrom: ['Read again soon', 0] },
  ...ghlSave('clinic', 'read', 'Clinic: read', -300),
  afterSave(codeNode('Store: read', readCode('store'), -300), 'clinic', 'read'),
  ...ghlSave('store', 'read', 'Store: read', -300),
  afterSave(codeNode('CRM data', [
    '/*@lib*/',
    ...STEP_HELPERS,
    PAGES,
    "// The report uses what GoHighLevel has, read back from it, like it would for a real client.",
    "const job = $('Start report').first().json;",
    "const crypto = require('crypto');",
    "const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');",
    'const nowSec = Math.floor(Date.now() / 1000);',
    'let steps = job.steps;',
    NAMES,
    'const readNotes = [], short = [], out = {};',
    'for (const [client, [label, name]] of Object.entries(NAMES)) {',
    "  const got = pages(`GHL ${client}: read`);",
    "  const r = Object.fromEntries($(`${label}: read`).all().map((s, i) => [s.json.kind, got[i] || []]));",
    `  const c = joinPages(r.contacts, 'contacts', ${MAX_PAGES}, ${PAGE}), d = joinPages(r.deals, 'opportunities', ${MAX_PAGES}, ${PAGE});`,
    "  const contacts = c?.rows ?? null, deals = d?.rows ?? null;",
    "  if (!contacts || !deals) readNotes.push(`${name}: GoHighLevel couldn't be read`);",
    `  else if (c.more || d.more) readNotes.push(\`\${name}: more than ${MAX_PAGES * PAGE} records; only the first ${MAX_PAGES * PAGE} were read\`);`,
    "  // the demo reads right after saving, and GoHighLevel's search can still answer with an older list (seen: 19 of 22, after a count of 22)",
    "  if (contacts && job.saved && contacts.length < job.saved[client]) short.push(`${name}: GoHighLevel's search found ${contacts.length} of the ${job.saved[client]} contacts saved`);",
    '  const dealOf = new Map((deals || []).map(d => [d.contactId, d]));',
    "  // deals lag in search too (measured: 4 to 7 s after saving), and the last one saved is the likeliest to be missing",
    "  const dealsFound = (contacts || []).filter(c => dealOf.has(c.id)).length;",
    "  if (contacts && job.savedDeals && dealsFound < job.savedDeals[client]) short.push(`${name}: GoHighLevel's search found ${dealsFound} of the ${job.savedDeals[client]} deals saved`);",
    '  const leads = (contacts || []).map(c => {',
    "    // ponytail: the demo's made-up date is kept in a created: tag; a real contact uses its dateAdded",
    "    const d = dealOf.get(c.id), created = (c.tags || []).find(t => t.startsWith('created:'));",
    "    return { id: c.id, firstName: c.firstName ?? '', lastName: c.lastName ?? '', email: c.email ?? '', phone: c.phone ?? '', source: c.source ?? null,",
    "      createdAt: new Date(created ? +created.slice(8) : Date.parse(c.dateAdded)).toISOString(),",
    "      outcome: !d ? 'open' : d.status === 'won' ? 'converted' : 'cancelled', value: d ? Number(d.monetaryValue) || 0 : 0, flags: [] };",
    '  });',
    '  const meta = buildMetaEvents(client, leads, job.problems, nowSec, sha256);',
    '  out[client] = { client, name, leads, spend: job.spend[client], ...meta };',
    '}',
    `if (short.length && $runIndex < ${READ_TRIES - 1}) return [{ json: { again: true } }];`,
    "// ponytail: after the last try the report shows what search found, and says so",
    "if (short.length) { const g = steps.find(s => s.key === 'ghl'); steps = setStep(steps, 'ghl', g.status === 'failed' ? 'failed' : 'warning', [g.reason, ...short].filter(Boolean).join('; ')); }",
    "if (readNotes.length) steps = setStep(steps, 'ghl', 'failed', readNotes.join('; '));",
    "steps = setStep(steps, 'spend', 'done');",
    "steps = setStep(steps, 'meta', 'running');",
    'return [{ json: { runId: job.runId, problems: job.problems, weekStart: job.weekStart, ranAt: job.ranAt, clients: out, steps } }];'], -300), 'store', 'read'),
  { name: 'Read everything?', y: -300, type: 'n8n-nodes-base.if', v: 2, params: ifTrue('={{ !$json.again }}', sid('read everything')) },
  sql('Save progress 1', [
    '-- show the visitor the CRM step is done',
    'with u as (update demo_runs set steps = $2::jsonb where id = $1::uuid)',
    'select 1 as saved'],
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
    '  return { client: c.client, name: c.name, kpis, warnings, skipped: c.skipped, campaigns: campaignRows(c.spend, c.leads, weekStart),',
    '    days: runDays(c.client, c.leads, c.spend, weekStart, meta), leadList: leadList(c.leads, weekStart) };',
    '});',
    "steps = setStep(steps, 'meta', metaFailed.length ? 'failed' : 'done', metaFailed.join('; ') || undefined);",
    "steps = setStep(steps, 'checks', 'done');",
    'return [{ json: { ...crm, clients, steps } }];'], -300),
  codeNode('Build report', [
    '/*@lib*/',
    "const ck = $('Checks').first().json;",
    'const metaSkipped = ck.clients.reduce((a, c) => a + c.skipped, 0);',
    'const report = buildReport({ runId: ck.runId, weekStart: ck.weekStart, asOf: ck.ranAt, clients: ck.clients, steps: ck.steps, problems: ck.problems, metaSkipped });',
    "return [{ json: { runId: ck.runId, status: report.partial ? 'partial' : 'done', report, steps: ck.steps } }];"], -300),
  sql('Save result', 'update demo_runs set status = $2, report = $3::jsonb, steps = $4::jsonb where id = $1::uuid returning id',
    '={{ [$json.runId, $json.status, JSON.stringify($json.report), JSON.stringify($json.steps)] }}', -300),
  ...(SLACK ? [
    codeNode('Slack message', ['/*@lib*/', '// only when a person should look: a step failed or a check fired',
      "const text = alertText($('Build report').first().json.report, 'https://ibrahim-jaafar.github.io/agency-demo/');",
      `return text ? [{ json: { req: ${slackReq('text')} } }] : [];`], -300),
    slackSend(-300)] : []),
];

// ---------- cleanup (demo only): after the report is saved, delete demo contacts older than 7 days (GoHighLevel removes their deals too) ----------
// Here and not on a schedule: the free server sleeps, so a nightly job wouldn't fire. The visitor already has the report.
const CLEANUP_HOURS = Number(process.env.CLEANUP_HOURS) || 7 * 24; // ponytail: the env override is only for testing
const CLEANUP_MAX = 25; // per client per run: more than a run creates, and about 13 s at 2 a second
const cleanup = (c, y) => {
  const L = CLIENTS[c].label;
  return [
    { branch: ['Run the weekly report', 0], x: 880 },
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

// ---------- the AI summary, on request, for whatever period the dashboard shows ----------
// The page sends only which period (no numbers, no text): the figures are worked out here from the latest report
// with the same code the dashboard uses, so nobody can feed the AI their own words. One answer covers both clients.
// Answers are kept (demo_summaries): a finished period is written once per run, one still under way once an hour.
const SUMMARY_AI_PER_DAY = 40; // Gemini's free tier is 20 a day per model; past this the template writes
const summary = [
  { name: 'Summary webhook', type: 'n8n-nodes-base.webhook', v: 2, params: { httpMethod: 'POST', path: 'demo/summary', responseMode: 'responseNode', options: { allowedOrigins: ORIGIN } }, extra: { webhookId: sid('demo/summary') } },
  sql('Make cache table', 'create table if not exists demo_summaries (key text primary key, body jsonb not null, created_at timestamptz not null default now())', null, 0, { alwaysOutputData: true }),
  sql('Latest report', "select (select json_build_object('runId', id, 'report', report) from demo_runs where status in ('done','partial') order by created_at desc limit 1) as latest", null, 0, { alwaysOutputData: true }),
  codeNode('Figures', [
    '/*@lib*/',
    "let body = $('Summary webhook').first().json.body;",
    "if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }",
    "if (!body || typeof body !== 'object') body = {};",
    "const period = ['day', 'week', 'month', 'year'].includes(body.period) ? body.period : 'week';",
    'const back = Number.isInteger(body.back) && body.back >= 0 && body.back < 1000 ? body.back : 0;',
    "const dayVs = body.dayVs === 'prev' ? 'prev' : 'week', broken = body.broken === true;",
    "const latest = $('Latest report').first().json.latest;",
    "if (!latest?.report) return [{ json: { none: true, key: '' } }];",
    'const report = latest.report, now = new Date();',
    'const figs = report.clients.map(c => ({ c, f: periodFigures(c.client, { ...c, asOf: report.asOf }, period, now, back, dayVs) }));',
    'const f = figs[0].f, named = periodWords(period, back, dayVs, f.from);',
    "const aiInput = buildAiInput(figs.map(({ c, f }) => ({ client: c.client, name: c.name, kpis: f.kpis, previousKpis: f.before, warnings: f.health.warnings })), named);",
    `const aiBody = { messages: [{ role: 'system', content: ${JSON.stringify(AI_SYSTEM)} }, { role: 'user', content: JSON.stringify(aiInput) }],`,
    "  response_format: { type: 'json_schema', json_schema: { name: 'summary', strict: true, schema: AI_SCHEMA } } };",
    "// a period under way changes as the day goes on: kept for the hour (or until the run's data changes)",
    "const at = !f.current ? '' : f.cut ? f.asOf : f.asOf.slice(0, 13);",
    "const key = [latest.runId, period, f.from, f.to, dayVs, at].join('|');",
    'const out = { period: named, from: f.from, to: f.to, current: f.current, asOf: f.asOf };',
    'return [{ json: { key, broken, aiInput, aiBody, out } }];'], 0),
  sql('Cached?', ["select (select body from demo_summaries where key = $1) as body,",
    `  (select count(*) from demo_summaries where created_at > now() - interval '1 day')::int as today`], '={{ [$json.key] }}', 0, { alwaysOutputData: true }),
  codeNode('Decide AI', [
    "const fx = $('Figures').first().json, row = $input.first().json;",
    `const overLimit = (row.today ?? 0) >= ${SUMMARY_AI_PER_DAY};`,
    "// the broken-answer test skips any kept answer (it would hide the test) and never needs the AI: its reply is replaced anyway",
    'const cached = fx.broken ? null : row.body ?? null;',
    'return [{ json: { cached, overLimit, needAi: !fx.none && !cached && !fx.broken && !overLimit } }];'], 0),
  { name: 'Ask Gemini?', type: 'n8n-nodes-base.if', v: 2, params: ifTrue('={{ $json.needAi }}', sid('ask gemini')) },
  aiNode('AI: write summary', AI_MODELS.first, 'Figures'),
  codeNode('Check AI answer', ['/*@lib*/', "const fx = $('Figures').first().json;",
    'return [{ json: { ok: !!pickAiAnswer($input.all().map(i => i.json), fx.aiInput).value } }];'], 0),
  { name: 'AI answer ok?', type: 'n8n-nodes-base.if', v: 2, params: ifTrue('={{ $json.ok }}', sid('summary ai ok')) },
  { branch: ['AI answer ok?', 1], x: 2200 },
  { ...aiNode('AI: second try', AI_MODELS.second, 'Figures'), y: 200 },
  { ...codeNode('Build answer', [
    '/*@lib*/',
    "const fx = $('Figures').first().json, d = $('Decide AI').first().json;",
    "if (fx.none) return [{ json: { code: 404, save: false, body: { error: 'There is no report yet: run the report first.' } } }];",
    'if (d.cached) return [{ json: { code: 200, save: false, body: { ...d.cached, cached: true } } }];',
    '// the demo\'s "broken AI answer": the reply is a refusal, which the checks turn down, so the template writes',
    "const replies = fx.broken ? [{ statusCode: 200, body: { choices: [{ message: { content: \"Sorry, I can't help with that.\" } }] } }]",
    "  : ['AI: write summary', 'AI: second try'].filter(n => $(n).isExecuted).flatMap(n => $(n).all().map(i => i.json));",
    'const pick = pickAiAnswer(replies, fx.aiInput);',
    "const why = pick.value ? null : d.overLimit ? 'the demo’s AI allowance for today is used up' : fx.broken ? 'the AI’s answer was a refusal, so the checks turned it down'",
    "  : pick.gotAnswer ? `the AI’s answer failed the checks (${pick.errors[0]})` : `the AI didn’t answer (${pick.errors[0] ?? 'no reply'}); try again in a minute`;",
    "const body = { ...fx.out, source: pick.value ? 'ai' : 'template', why, value: pick.value ?? templateSummary(fx.aiInput) };",
    "return [{ json: { code: 200, save: body.source === 'ai', body } }];"], 0), alsoFrom: [['AI answer ok?', 0], ['Ask Gemini?', 1]] },
  { name: 'Keep it?', type: 'n8n-nodes-base.if', v: 2, params: ifTrue('={{ $json.save }}', sid('keep summary')) },
  sql('Keep summary', 'insert into demo_summaries (key, body) values ($1, $2::jsonb) on conflict (key) do nothing returning key',
    "={{ [$('Figures').first().json.key, JSON.stringify($('Build answer').first().json.body)] }}", 0, { alwaysOutputData: true }),
  { name: 'Respond summary', type: 'n8n-nodes-base.respondToWebhook', v: 1.1, alsoFrom: ['Keep it?', 1],
    params: { respondWith: 'json', responseBody: "={{ JSON.stringify($('Build answer').first().json.body) }}", options: { responseCode: "={{ $('Build answer').first().json.code }}" } } },
];

// ---------- a test lead: one made-up customer arriving now, through the real systems ----------
// After a run nothing arrives on its own; this pushes one more customer through GoHighLevel (and Meta when they book
// or order) and adds them to the latest run, which must be from today. A few seconds apart, at most TEST_LEADS_MAX a run.
const TEST_LEADS_MAX = 30, TEST_LEAD_GAP_SEC = 5;
const testContactReq = c => `{ method: 'POST', url: '${GHL}/contacts/', body: { locationId: '${CLIENTS[c].location}', firstName: t.lead.firstName, lastName: t.lead.lastName, email: t.lead.email, phone: t.lead.phone,
    tags: ['demo', 'test-lead', \`run:\${t.runId}\`, \`created:\${Date.parse(t.lead.createdAt)}\`], ...(t.lead.source ? { source: t.lead.source } : {}) } }`;
const testDeal = c => [
  `// ${CLIENTS[c].name}: a deal when the test lead booked, ordered, cancelled or was refunded`,
  "const t = $('Plan test lead').first().json, r = $input.first().json;",
  "const contactId = r.statusCode < 300 ? r.body?.contact?.id : null;",
  `const G = '${GHL}';`,
  "if (contactId && t.lead.outcome !== 'open') return [{ json: { contactId, req: { method: 'POST', url: `${G}/opportunities/`, body: {",
  `  locationId: '${CLIENTS[c].location}', pipelineId: '${CLIENTS[c].pipeline}', pipelineStageId: '${CLIENTS[c].stage}', contactId,`,
  `  name: \`\${t.lead.firstName} \${t.lead.lastName} – ${c === 'clinic' ? 'consultation' : 'order'}\`, status: t.lead.outcome === 'converted' ? 'won' : 'lost', monetaryValue: t.lead.value } } } }];`,
  "// ponytail: one harmless lookup when there's no deal to save (n8n stops a branch with no items)",
  `return [{ json: { contactId, req: { method: 'POST', url: \`\${G}/contacts/search\`, body: { locationId: '${CLIENTS[c].location}', pageLimit: 1 } } } }];`,
];
const testLeadSteps = [
  { name: 'Lead webhook', type: 'n8n-nodes-base.webhook', v: 2, params: { httpMethod: 'POST', path: 'demo/lead', responseMode: 'responseNode', options: { allowedOrigins: ORIGIN } }, extra: { webhookId: sid('demo/lead') } },
  sql('Latest run', "select (select json_build_object('id', id, 'status', status, 'report', report) from demo_runs order by created_at desc limit 1) as latest", null, 0, { alwaysOutputData: true }),
  codeNode('Plan test lead', [
    '/*@lib*/',
    "let ask = $('Lead webhook').first().json.body;",
    "if (typeof ask === 'string') { try { ask = JSON.parse(ask); } catch { ask = null; } }",
    "const client = ask?.client === 'store' ? 'store' : 'clinic';",
    "const latest = $input.first().json.latest, rep = latest?.report, now = Date.now();",
    "const refuse = (code, error) => [{ json: { refuse: { code, error } } }];",
    "if (latest?.status === 'running') return refuse(409, 'A run is going: send test leads once it has finished.');",
    "if (!rep?.asOf || rep.asOf.slice(0, 10) !== new Date(now).toISOString().slice(0, 10)) return refuse(409, 'Test leads join today’s run: run the report first.');",
    `if ((rep.testLeads || 0) >= ${TEST_LEADS_MAX}) return refuse(429, 'This run has had its ${TEST_LEADS_MAX} test leads: run the report again for more.');`,
    `if (now - Date.parse(rep.asOf) < ${TEST_LEAD_GAP_SEC * 1000}) return refuse(429, 'One test lead every ${TEST_LEAD_GAP_SEC} seconds, please.');`,
    '// a mixed seed: seeds a few seconds apart would give nearly the same person',
    'const lead = testLead(client, makeRng(seedOf(`${client}:${now}`)), now);',
    'return [{ json: { client, runId: latest.id, lead } }];'], 0),
  { name: 'Allowed?', type: 'n8n-nodes-base.if', v: 2, params: ifTrue('={{ !$json.refuse }}', sid('test lead allowed')) },
  { name: 'Clinic?', type: 'n8n-nodes-base.if', v: 2, params: ifTrue("={{ $json.client === 'clinic' }}", sid('test lead clinic')) },
  codeNode('Clinic: test contact', ["const t = $input.first().json;", `return [{ json: { req: ${testContactReq('clinic')} } }];`], 0),
  ghlHttp('clinic', 'test contact', 0),
  codeNode('Clinic: test deal', testDeal('clinic'), 0),
  ghlHttp('clinic', 'test deal', 0),
  { name: 'Clinic saved', type: 'n8n-nodes-base.noOp', v: 1, params: {} },
  { branch: ['Clinic?', 1], x: 1100 },
  { ...codeNode('Store: test contact', ["const t = $input.first().json;", `return [{ json: { req: ${testContactReq('store')} } }];`], 200) },
  ghlHttp('store', 'test contact', 200),
  codeNode('Store: test deal', testDeal('store'), 200),
  ghlHttp('store', 'test deal', 200),
  { name: 'After GoHighLevel', y: 0, alsoFrom: ['Clinic saved', 0], ...codeNode('After GoHighLevel', [
    '/*@lib*/',
    "const t = $('Plan test lead').first().json, label = t.client === 'clinic' ? 'Clinic' : 'Store';",
    "const deal = $(`${label}: test deal`).first().json, dealReply = $input.first().json;",
    "const saved = !!deal.contactId, dealOk = t.lead.outcome === 'open' || dealReply.statusCode < 300;",
    "if (!saved) return [{ json: { ...t, saved, dealOk, meta: null } }];",
    "// a booking or order goes to Meta, like the run's",
    "const crypto = require('crypto');",
    "const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');",
    "const ev = buildMetaEvents(t.client, [t.lead], [], Math.floor(Date.now() / 1000), sha256).events;",
    `const meta = ev.length ? { method: 'POST', url: '${META_URL}', body: { data: ev, test_event_code: '${env.META_TEST_EVENT_CODE}' } } : null;`,
    'return [{ json: { ...t, saved, dealOk, meta, req: meta } }];'], 0) },
  { name: 'To Meta?', type: 'n8n-nodes-base.if', v: 2, params: ifTrue('={{ !!$json.meta }}', sid('test lead meta')) },
  { ...http('Meta: send test conversion', header('N8N_CRED_META', 'Meta CAPI')), y: 0 },
  { ...codeNode('Add to the run', [
    '/*@lib*/',
    "const t = $('After GoHighLevel').first().json, latest = $('Latest run').first().json.latest;",
    "const metaReply = $('Meta: send test conversion').isExecuted ? $('Meta: send test conversion').first().json : null;",
    "const metaOk = !!metaReply && metaReply.statusCode === 200 && Number(metaReply.body?.events_received) === 1;",
    "if (!t.saved) return [{ json: { code: 502, save: false, body: { error: 'GoHighLevel didn’t take the test lead. Please try again in a minute.' } } }];",
    'const report = addTestLead(latest.report, t.client, t.lead, metaOk);',
    "const name = `${t.lead.firstName} ${[...t.lead.lastName][0] ?? ''}.`;",
    "return [{ json: { code: 200, save: true, runId: t.runId, report, body: { name, client: t.client, source: t.lead.source, outcome: t.lead.outcome, value: t.lead.value,",
    "  createdAt: t.lead.createdAt, deal: t.lead.outcome === 'open' ? null : t.dealOk, meta: t.meta ? metaOk : null } } }];"], 0), alsoFrom: ['To Meta?', 1] },
  { name: 'Save it?', type: 'n8n-nodes-base.if', v: 2, params: ifTrue('={{ $json.save }}', sid('test lead save')) },
  // saved only if the run hasn't changed since it was read: two test leads at once can't overwrite each other
  sql('Save the run', "update demo_runs set report = $2::jsonb where id = $1::uuid and report->>'asOf' = $3 returning id",
    "={{ [$json.runId, JSON.stringify($json.report), $('Latest run').first().json.latest.report.asOf] }}", 0, { alwaysOutputData: true }),
  { ...codeNode('Answer', [
    "const a = $('Add to the run').first().json;",
    'if (!a.save) return [{ json: { code: a.code, body: a.body } }];',
    'if ($input.first().json.id) return [{ json: { code: 200, body: a.body } }];',
    "return [{ json: { code: 409, body: { error: 'Another test lead arrived at the same moment. Please try again.' } } }];"], 0), alsoFrom: ['Save it?', 1] },
  { name: 'Respond test lead', type: 'n8n-nodes-base.respondToWebhook', v: 1.1,
    params: { respondWith: 'json', responseBody: '={{ JSON.stringify($json.body) }}', options: { responseCode: '={{ $json.code }}' } } },
  { branch: ['Allowed?', 1], x: 660 },
  { name: 'Respond refused', y: 400, type: 'n8n-nodes-base.respondToWebhook', v: 1.1,
    params: { respondWith: 'json', responseBody: "={{ JSON.stringify({ error: $json.refuse.error }) }}", options: { responseCode: '={{ $json.refuse.code }}' } } },
];

const demoRun = workflow('demo-run', [...start, ...refuse, ...run, ...catchUpLoop, ...cleanup('clinic', 600), ...cleanup('store', 800)]);
const weeklyReport = workflow('weekly-report', [...report,
  { branch: ['Read everything?', 1], x: 3080 },
  { name: 'Read again soon', y: -100, type: 'n8n-nodes-base.wait', v: 1.1, params: { resume: 'timeInterval', amount: 5, unit: 'seconds' }, extra: { webhookId: sid('read again') } },
]);
// the editor's "Tidy up" layout (Ibrahim's, it's the portfolio picture): one line, retries above, the re-read loop below
const REPORT_LAYOUT = { 'Start report': 64, 'Clinic: read': 64, 'GHL clinic: read (pause)': -80, 'GHL clinic: read (retry)': -80,
  'GHL store: read (pause)': -80, 'GHL store: read (retry)': -80 };
weeklyReport.nodes.forEach((n, i) => {
  if (n.name === 'Read again soon') n.position = [3376, 160];
  else n.position = [16 + 224 * i, REPORT_LAYOUT[n.name] ?? (i > 14 ? -48 : 0)];
});

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
  ...(SLACK ? [
    { branch: ['On error', 0], x: 220 },
    codeNode('Slack message', ["const e = $('On error').first().json.execution ?? {};",
      "const text = `:rotating_light: Agency demo run crashed: ${String(e.error?.message ?? 'unknown error').slice(0, 300)} (node: ${e.lastNodeExecuted ?? '?'})\\nRun in n8n: ${e.url ?? 'no link'}`;",
      `return [{ json: { req: ${slackReq('text')} } }];`], 200),
    slackSend(200)] : []),
]);

const demoSummary = workflow('demo-summary', summary);
const demoLead = workflow('demo-lead', testLeadSteps);

for (const wf of [demoRun, weeklyReport, demoStatus, demoSummary, demoLead, errorHandler]) writeFileSync(new URL(`../workflows/src/${wf.name}.json`, import.meta.url), JSON.stringify(wf, null, 2) + '\n');
console.log('templates written');
