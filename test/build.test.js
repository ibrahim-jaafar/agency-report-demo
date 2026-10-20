import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LIB_ORDER, libSource, buildWorkflow, buildAll } from '../scripts/build-workflows.mjs';

test('lib order is fixed and complete', () => {
  assert.deepEqual(LIB_ORDER, ['rng', 'scenario', 'leads', 'spend', 'kpis', 'checks', 'meta', 'ai', 'limits', 'report']);
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
  const wf = JSON.parse(readFileSync(new URL('../workflows/src/weekly-report.json', import.meta.url), 'utf8'));
  const line = wf.nodes.find(n => n.name === 'CRM data').parameters.jsCode.split('\n').find(l => l.startsWith('const answers'));
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

test('the weekly report only reads GoHighLevel, and the demo hands over to it', () => {
  const wf = name => JSON.parse(readFileSync(new URL(`../workflows/src/${name}.json`, import.meta.url), 'utf8'));
  const report = wf('weekly-report'), demo = wf('demo-run');
  const reqs = report.nodes.filter(n => n.type === 'n8n-nodes-base.code').map(n => n.parameters.jsCode).join('\n').match(/method: '[A-Z]+', url: `[^`]*`/g);
  assert.deepEqual([...new Set(reqs)].sort(), ["method: 'GET', url: `${G}/opportunities/search?location_id=${L}&pipeline_id=${P}&limit=100`", "method: 'POST', url: `${G}/contacts/search`"]);
  assert.equal(report.nodes[0].type, 'n8n-nodes-base.executeWorkflowTrigger');
  const call = demo.nodes.find(n => n.type === 'n8n-nodes-base.executeWorkflow');
  assert.equal(call.parameters.workflowId.value, 'weekly-report');
  assert.equal(call.parameters.options.waitForSubWorkflow, true, 'cleanup must wait for the report');
  for (const n of ['Meta: send conversions', 'AI: write summary', 'Checks']) assert.ok(!demo.nodes.some(x => x.name === n) && report.nodes.some(x => x.name === n), n);
});
