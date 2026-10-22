import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LIB_ORDER, libSource, buildWorkflow, buildAll } from '../scripts/build-workflows.mjs';

test('lib order is fixed and complete', () => {
  assert.deepEqual(LIB_ORDER, ['rng', 'scenario', 'leads', 'spend', 'kpis', 'daily', 'checks', 'meta', 'ai', 'limits', 'report']);
});

test('lib source has no import/export and defines every function in one scope', () => {
  const src = libSource();
  assert.ok(!/^\s*(import|export)\s/m.test(src));
  const names = ['makeRng', 'parseScenario', 'generateLeads', 'simulateSpend', 'computeKpis', 'runChecks', 'buildMetaEvents', 'validateAiOutput', 'checkLimits', 'buildReport'];
  const types = new Function(`${src}\nreturn [${names.map(n => `typeof ${n}`).join(',')}];`)();
  assert.deepEqual(types, names.map(() => 'function'));
});

test('only Code nodes with the marker get the lib; others untouched', () => {
  const tpl = { nodes: [
    { type: 'n8n-nodes-base.code', parameters: { jsCode: '/*@lib*/\nreturn [{ json: { ok: typeof checkLimits } }];' } },
    { type: 'n8n-nodes-base.code', parameters: { jsCode: 'return [];' } },
    { type: 'n8n-nodes-base.webhook', parameters: { path: '/*@lib*/' } },
  ] };
  const out = buildWorkflow(tpl, libSource());
  const code = out.nodes[0].parameters.jsCode;
  assert.ok(!code.includes('/*@lib*/'));
  assert.ok(!/^\s*export\s/m.test(code));
  assert.equal(new Function(code)()[0].json.ok, 'function');
  assert.equal(out.nodes[1].parameters.jsCode, 'return [];');
  assert.equal(out.nodes[2].parameters.path, '/*@lib*/');
  assert.ok(tpl.nodes[0].parameters.jsCode.includes('/*@lib*/'), 'template not mutated');
});

test('buildAll writes every template to dist', () => {
  const src = mkdtempSync(join(tmpdir(), 'src-')), dist = mkdtempSync(join(tmpdir(), 'dist-'));
  writeFileSync(join(src, 'a.json'), JSON.stringify({ nodes: [{ type: 'n8n-nodes-base.code', parameters: { jsCode: '/*@lib*/' } }] }));
  assert.deepEqual(buildAll(src, dist), ['a.json']);
  assert.ok(JSON.parse(readFileSync(join(dist, 'a.json'), 'utf8')).nodes[0].parameters.jsCode.includes('function makeRng'));
});

test('lib is injected byte for byte (no $-pattern rewriting)', () => {
  const tpl = { nodes: [{ type: 'n8n-nodes-base.code', parameters: { jsCode: '/*@lib*/' } }] };
  const lib = 'const money = n => `$${n}`; // $& $\' $1';
  assert.equal(buildWorkflow(tpl, lib).nodes[0].parameters.jsCode, lib);
});

test('answers() puts retried GoHighLevel replies back in their place', () => {
  const wf = JSON.parse(readFileSync(new URL('../workflows/src/demo-run.json', import.meta.url), 'utf8'));
  const line = wf.nodes.find(n => n.name === 'Hand over').parameters.jsCode.split('\n').find(l => l.startsWith('const answers'));
  const j = o => ({ json: o });
  const nodes = {
    N: [j({ statusCode: 201, a: 0 }), j({ statusCode: 429 }), j({ statusCode: 201, a: 2 }), j({ statusCode: 429 })],
    'N (refused)': [j({ i: 1 }), j({ i: 3 })],
    'N (retry)': [j({ statusCode: 201, a: 1 }), j({ statusCode: 429 })],
  };
  const $ = n => ({ all: () => nodes[n], isExecuted: n in nodes });
  const answers = new Function('$', `${line}\nreturn answers;`)($);
  assert.deepEqual(answers('N').map(r => r.a ?? r.statusCode), [0, 1, 2, 429]);
  delete nodes['N (retry)'];
  assert.deepEqual(answers('N').map(r => r.a ?? r.statusCode), [0, 429, 2, 429]);
});

test("pages() groups paged replies by request and puts a retried request's pages in its place", () => {
  const wf = JSON.parse(readFileSync(new URL('../workflows/src/weekly-report.json', import.meta.url), 'utf8'));
  const line = wf.nodes.find(n => n.name === 'CRM data').parameters.jsCode.split('\n').find(l => l.startsWith('const pages'));
  const j = (o, item) => ({ json: o, pairedItem: { item } });
  const nodes = {
    N: [j({ p: 'c1' }, 0), j({ p: 'd1' }, 1), j({ p: 'c2' }, 0), j({ statusCode: 429 }, 1)],
    'N (refused)': [j({ i: 1 }, 0)],
    'N (retry)': [j({ p: 'd1' }, 0), j({ p: 'd2' }, 0)],
  };
  const $ = n => ({ all: () => nodes[n], isExecuted: n in nodes });
  const pages = new Function('$', `${line}\nreturn pages;`)($);
  assert.deepEqual(pages('N').map(r => r.map(x => x.p ?? x.statusCode)), [['c1', 'c2'], ['d1', 'd2']]);
  delete nodes['N (retry)'];
  assert.deepEqual(pages('N').map(r => r.map(x => x.p ?? x.statusCode)), [['c1', 'c2'], ['d1', 429]]);
});

test('the report reads GoHighLevel again while its search finds fewer contacts than the run saved', () => {
  const tpl = JSON.parse(readFileSync(new URL('../workflows/src/weekly-report.json', import.meta.url), 'utf8'));
  const next = n => tpl.connections[n].main.map(o => o.map(c => c.node));
  assert.deepEqual(next('CRM data'), [['Read everything?']]);
  assert.deepEqual(next('Read everything?'), [['Save progress 1'], ['Read again soon']]);
  assert.deepEqual(next('Read again soon'), [['Clinic: read']]);
  const code = buildWorkflow(tpl, libSource()).nodes.find(n => n.name === 'CRM data').parameters.jsCode;
  const steps = [{ key: 'ghl', status: 'done' }, { key: 'spend', status: 'pending' }, { key: 'meta', status: 'pending' }];
  const job = { runId: 'r', problems: [], weekStart: '2026-10-12T00:00:00.000Z', ranAt: '2026-10-19T00:00:00.000Z', steps,
    spend: { clinic: {}, store: {} }, select: { tag: 'run:r' }, saved: { clinic: 1, store: 2 } };
  const contact = id => ({ id, firstName: 'A', tags: ['created:1792000000000'] });
  const run = (storeContacts, runIndex, saved = job.saved) => {
    const reads = { Clinic: [contact('c1')], Store: storeContacts };
    const nodes = { 'Start report': [{ json: { ...job, saved } }] };
    for (const [label, cs] of Object.entries(reads)) {
      const c = label.toLowerCase();
      nodes[`${label}: read`] = [{ json: { kind: 'contacts' } }, { json: { kind: 'deals' } }];
      nodes[`GHL ${c}: read`] = [{ json: { statusCode: 200, body: { contacts: cs } }, pairedItem: { item: 0 } }, { json: { statusCode: 200, body: { opportunities: [] } }, pairedItem: { item: 1 } }];
    }
    const $ = n => ({ all: () => nodes[n], first: () => nodes[n][0], isExecuted: n in nodes });
    return new Function('$', '$runIndex', 'require', code)($, runIndex, () => ({ createHash: () => ({ update: () => ({ digest: () => 'h' }) }) }))[0].json;
  };
  assert.equal(run([contact('s1')], 0).again, true);
  const last = run([contact('s1')], 5);
  assert.ok(!last.again);
  assert.deepEqual(last.steps[0], { key: 'ghl', status: 'warning', reason: "Northwind Home: GoHighLevel's search found 1 of the 2 contacts saved" });
  assert.ok(!run([contact('s1'), contact('s2')], 0).again);
  assert.ok(!run([contact('s1')], 0, null).again, 'a real client has no saved count, so one read is enough');
});

test("only the report's reads page through GoHighLevel; saves send one request each", () => {
  const wf = name => JSON.parse(readFileSync(new URL(`../workflows/src/${name}.json`, import.meta.url), 'utf8'));
  const paged = w => wf(w).nodes.filter(n => n.parameters.options?.pagination).map(n => n.name);
  assert.deepEqual(paged('weekly-report'), ['GHL clinic: read', 'GHL clinic: read (retry)', 'GHL store: read', 'GHL store: read (retry)']);
  assert.deepEqual(paged('demo-run'), []);
});

test('the weekly report only reads GoHighLevel, and the demo hands over to it', () => {
  const wf = name => JSON.parse(readFileSync(new URL(`../workflows/src/${name}.json`, import.meta.url), 'utf8'));
  const report = wf('weekly-report'), demo = wf('demo-run');
  const reqs = report.nodes.filter(n => n.type === 'n8n-nodes-base.code').map(n => n.parameters.jsCode).join('\n').match(/method: '[A-Z]+', url: `[^`]*`/g);
  assert.deepEqual([...new Set(reqs)].sort(), ["method: 'GET', url: `${G}/opportunities/search?location_id=${L}&pipeline_id=${P}&limit=100`", "method: 'POST', url: `${G}/contacts/search`"]);
  assert.equal(report.nodes[0].type, 'n8n-nodes-base.executeWorkflowTrigger');
  const call = demo.nodes.find(n => n.type === 'n8n-nodes-base.executeWorkflow');
  assert.equal(call.parameters.workflowId.value, 'weekly-report');
  assert.equal(call.parameters.options.waitForSubWorkflow, true, 'cleanup must wait for the report');
  // GoHighLevel's search lags behind saves, so the demo hands over only once search finds this run's contacts
  const next = n => demo.connections[n].main.map(o => o.map(c => c.node));
  assert.deepEqual(next('Hand over'), [['Clinic: count']]);
  assert.deepEqual(next('All searchable?'), [['Pass it on'], ['Look again soon']]);
  assert.deepEqual(next('Look again soon'), [['Clinic: count']]);
  assert.deepEqual(next('Pass it on'), [['Run the weekly report']]);
  // Slack: the report posts after it's saved; a crash posts from the error workflow, whether or not a run was marked failed
  const link = (w, n) => w.connections[n].main.map(o => o.map(c => c.node));
  assert.deepEqual(link(report, 'Save result'), [['Slack message']]);
  assert.deepEqual(link(report, 'Slack message'), [['Slack: send']]);
  assert.deepEqual(link(wf('error-handler'), 'On error'), [['Mark run failed', 'Slack message']]);
  for (const n of ['Meta: send conversions', 'Checks']) assert.ok(!demo.nodes.some(x => x.name === n) && report.nodes.some(x => x.name === n), n);
  // the AI writes only on request, for a period the page names: never in the run
  const summary = wf('demo-summary');
  assert.ok(![demo, report].some(w => w.nodes.some(x => x.name.startsWith('AI'))));
  assert.ok(summary.nodes.some(x => x.name === 'AI: write summary'));
  assert.deepEqual(link(summary, 'Ask Gemini?'), [['AI: write summary'], ['Build answer']]);
  assert.deepEqual(link(summary, 'AI answer ok?'), [['Build answer'], ['AI: second try']]);
  assert.deepEqual(link(summary, 'Keep it?'), [['Keep summary'], ['Respond summary']]);
});

test('every Code node compiles once the lib is pasted in: no name in a node clashes with the lib', async () => {
  const { readdirSync } = await import('node:fs');
  const lib = libSource();
  for (const f of readdirSync(new URL('../workflows/src/', import.meta.url)).filter(f => f.endsWith('.json'))) {
    const wf = buildWorkflow(JSON.parse(readFileSync(new URL(`../workflows/src/${f}`, import.meta.url), 'utf8')), lib);
    for (const n of wf.nodes.filter(n => n.type === 'n8n-nodes-base.code')) {
      // n8n runs a Code node as the body of an async function
      assert.doesNotThrow(() => new Function(`return (async () => {\n${n.parameters.jsCode}\n})`), `${f} / ${n.name}`);
    }
  }
});

test('a test lead goes through GoHighLevel, then Meta only when it converted, and saves only an unchanged run', () => {
  const w = JSON.parse(readFileSync(new URL('../workflows/src/demo-lead.json', import.meta.url), 'utf8'));
  const next = n => w.connections[n].main.map(o => o.map(c => c.node));
  assert.deepEqual(next('Allowed?'), [['Clinic?'], ['Respond refused']]);
  assert.deepEqual(next('Clinic?'), [['Clinic: test contact'], ['Store: test contact']]);
  assert.deepEqual(next('To Meta?'), [['Meta: send test conversion'], ['Add to the run']]);
  assert.deepEqual(next('Save it?'), [['Save the run'], ['Answer']]);
  assert.match(w.nodes.find(n => n.name === 'Save the run').parameters.query, /and report->>'asOf' = \$3/);
});
