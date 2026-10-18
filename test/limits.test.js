import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GAP_SEC, DAILY_MAX, checkLimits } from '../lib/limits.js';

const T0 = new Date('2026-10-18T12:00:00Z');
const at = s => new Date(+T0 + s * 1000);
const run = (id, sec, status = 'done') => ({ id, created_at: at(sec).toISOString(), status });

test('limits are the agreed starting values', () => { assert.equal(GAP_SEC, 60); assert.equal(DAILY_MAX, 50); });
test('no runs: ok', () => assert.deepEqual(checkLimits([], T0), { ok: true }));
test('second click joins the running run', () =>
  assert.deepEqual(checkLimits([run('r1', 0, 'running')], at(5)), { ok: false, reason: 'running', runId: 'r1', retryAfterSec: 0 }));
test('gap after a finished run', () =>
  assert.deepEqual(checkLimits([run('r1', 0)], at(30)), { ok: false, reason: 'gap', retryAfterSec: 30 }));
test('after the gap: ok', () => assert.deepEqual(checkLimits([run('r1', 0)], at(61)), { ok: true }));
test('daily cap, retry at next UTC midnight', () => {
  const runs = Array.from({ length: 50 }, (_, i) => run(`r${i}`, -3600 - i * 120));
  assert.deepEqual(checkLimits(runs, T0), { ok: false, reason: 'daily', retryAfterSec: 12 * 3600 });
});
test('yesterday\'s runs do not count toward today', () => {
  const runs = Array.from({ length: 50 }, (_, i) => run(`r${i}`, -13 * 3600 - i * 60));
  assert.deepEqual(checkLimits(runs, T0), { ok: true });
});
test('stuck run older than 10 min does not block', () =>
  assert.deepEqual(checkLimits([run('r1', -601, 'running')], T0), { ok: true }));
test('order of runs does not matter', () =>
  assert.equal(checkLimits([run('a', -500), run('b', -10), run('c', -300)], T0).reason, 'gap'));
