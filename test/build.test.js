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
