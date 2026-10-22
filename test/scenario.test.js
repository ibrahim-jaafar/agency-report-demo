import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRng } from '../lib/rng.js';
import { PROBLEMS, parseScenario, resolveProblems } from '../lib/scenario.js';

test('problem whitelist is the five keys in order (a broken AI is tried on the Generate button)', () => {
  assert.deepEqual(PROBLEMS, ['missing_source', 'duplicates', 'meta_mismatch', 'bad_totals', 'edge_cases']);
});

test('missing or junk body falls back to random', () => {
  for (const b of [undefined, null, 'x', 7, [], {}, { mode: 'evil' }, { mode: 'custom', problems: 'duplicates' }])
    assert.deepEqual(parseScenario(b), { mode: 'random', problems: [] });
});

test('clean mode is kept', () => {
  assert.deepEqual(parseScenario({ mode: 'clean', problems: ['duplicates'] }), { mode: 'clean', problems: [] });
});

test('custom keeps only whitelisted, unique problems', () => {
  assert.deepEqual(
    parseScenario({ mode: 'custom', problems: ['duplicates', 'rm -rf', 'duplicates', 'ai_broken', 3, null], extra: 1 }),
    { mode: 'custom', problems: ['duplicates'] });
  assert.equal(parseScenario({ mode: 'custom', problems: Array(10000).fill('duplicates') }).problems.length, 1);
});

test('custom with no valid problems behaves like clean', () => {
  assert.deepEqual(parseScenario({ mode: 'custom', problems: ['nope'] }), { mode: 'clean', problems: [] });
});

test('clean resolves to no problems', () => {
  assert.deepEqual(resolveProblems({ mode: 'clean', problems: [] }, makeRng(1)), []);
});

test('custom resolves to its own problems', () => {
  assert.deepEqual(resolveProblems({ mode: 'custom', problems: ['bad_totals'] }, makeRng(1)), ['bad_totals']);
});

test('random never includes ai_broken and sometimes includes each other problem', () => {
  const seen = new Set();
  for (let s = 0; s < 300; s++) {
    const p = resolveProblems({ mode: 'random', problems: [] }, makeRng(s));
    assert.ok(!p.includes('ai_broken'));
    p.forEach(x => seen.add(x));
  }
  assert.deepEqual([...seen].sort(), ['bad_totals', 'duplicates', 'edge_cases', 'meta_mismatch', 'missing_source']);
});
