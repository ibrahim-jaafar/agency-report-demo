import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRng } from '../lib/rng.js';
import { generateLeads } from '../lib/leads.js';
import { simulateSpend } from '../lib/spend.js';
import { runChecks, matchInjected } from '../lib/checks.js';

const W = new Date('2026-10-12T00:00:00Z');
const T = '2026-10-13T10:00:00.000Z';
let n = 0;
const lead = (o) => ({ id: `l${n++}`, firstName: 'A', lastName: 'B', email: `p${n}@x.com`, phone: `7000000${n % 10}${n}`, source: 'Ads', createdAt: T, outcome: 'open', value: 0, flags: [], ...o });
const spend = (total = 10) => ({ campaigns: [{ name: 'Ads', spend: 10, paidLeads: 1 }], reportedTotal: total, simulated: true });
const codes = w => w.map(x => x.code).sort();
const run = (o) => runChecks({ client: 'store', leads: [lead()], spend: spend(), meta: { sent: 0, accepted: 0, rejected: 0 }, weekStart: W, ...o });

test('clean generated data raises no warnings', () => {
  for (let s = 0; s < 30; s++) for (const c of ['clinic', 'store']) {
    const leads = generateLeads(c, [], makeRng(s), W);
    const conv = leads.filter(l => l.outcome === 'converted').length;
    const w = runChecks({ client: c, leads, spend: simulateSpend(c, leads, [], makeRng(s)), meta: { sent: conv, accepted: conv, rejected: 0 }, weekStart: W });
    assert.deepEqual(w, [], `seed ${s} ${c}: ${codes(w)}`);
  }
});

test('meta mismatch fires when Meta accepted a different number of conversions', () => {
  const w = run({ leads: [lead({ outcome: 'converted', value: 10 }), lead({ outcome: 'converted', value: 10 })], meta: { sent: 1, accepted: 1, rejected: 0 } });
  assert.deepEqual(codes(w), ['meta_mismatch']);
  assert.equal(w[0].count, 1);
});

test('no meta result (Meta step failed) skips the mismatch check', () => {
  assert.deepEqual(run({ leads: [lead({ outcome: 'converted', value: 10 })], meta: null }), []);
});

test('cancelled conversions do not count toward the Meta comparison', () => {
  assert.deepEqual(run({ leads: [lead({ outcome: 'cancelled', value: 10 })] }), []);
});

test('missing source', () => {
  const w = run({ leads: [lead({ source: null }), lead({ source: null }), lead()] });
  assert.deepEqual(codes(w), ['missing_source']);
  assert.equal(w[0].count, 2);
  assert.match(w[0].message, /2 leads have no recorded source/);
});

test('duplicates found across formatting', () => {
  const w = run({ leads: [lead({ email: 'a@b.com', phone: '+961 70 123 456' }), lead({ email: 'A@B.COM ', phone: '070123456' }), lead()] });
  assert.deepEqual(codes(w), ['duplicates']);
  assert.equal(w[0].count, 1);
});

test('same phone, different email is still a duplicate', () => {
  assert.deepEqual(codes(run({ leads: [lead({ phone: '70 111 222' }), lead({ phone: '+96170111222' })] })), ['duplicates']);
});

test('same person at both clients is not a duplicate (checks run per client)', () => {
  const shared = { email: 'jad@x.com', phone: '71555010' };
  assert.deepEqual(run({ client: 'clinic', leads: [lead(shared)] }), []);
  assert.deepEqual(run({ client: 'store', leads: [lead(shared)] }), []);
});

test('totals that do not add up', () => {
  assert.deepEqual(codes(run({ spend: spend(12.5) })), ['bad_totals']);
  assert.deepEqual(run({ spend: spend(10.004) }), []);
  assert.match(run({ spend: spend(8060.51) })[0].message, /\$8,060\.51/);
});

test('large order is flagged as an outlier (store, 3+ orders)', () => {
  const orders = [100, 120, 90, 2000].map(v => lead({ outcome: 'converted', value: v }));
  const w = run({ leads: orders, meta: { sent: 4, accepted: 4, rejected: 0 } });
  assert.deepEqual(codes(w), ['outlier']);
});

test('Meta rejected events raise a warning', () => {
  assert.deepEqual(codes(run({ meta: { sent: 1, accepted: 0, rejected: 1 } })), ['meta_rejected']);
});

test('out-of-period leads are ignored', () => {
  assert.deepEqual(run({ leads: [lead({ source: null, createdAt: '2026-10-19T00:00:00.000Z' })] }), []);
});

test('generated flaws are caught for every seed', () => {
  for (let s = 0; s < 50; s++) {
    const leads = generateLeads('store', ['missing_source', 'duplicates', 'bad_totals'], makeRng(s), W);
    const conv = leads.filter(l => l.outcome === 'converted').length;
    const w = runChecks({ client: 'store', leads, spend: simulateSpend('store', leads, ['bad_totals'], makeRng(s)), meta: { sent: conv, accepted: conv, rejected: 0 }, weekStart: W });
    for (const c of ['missing_source', 'duplicates', 'bad_totals']) assert.ok(codes(w).includes(c), `seed ${s} missing ${c}`);
  }
});

test('matchInjected reports misses honestly', () => {
  assert.deepEqual(matchInjected(['duplicates', 'bad_totals'], [{ code: 'duplicates', count: 1, message: '' }]),
    [{ problem: 'duplicates', caught: true }, { problem: 'bad_totals', caught: false }]);
});

test('matchInjected: edge cases need both outlier and meta_rejected; ai_broken is left to the report', () => {
  const w = c => c.map(code => ({ code, count: 1, message: '' }));
  assert.deepEqual(matchInjected(['edge_cases'], w(['outlier'])), [{ problem: 'edge_cases', caught: false }]);
  assert.deepEqual(matchInjected(['edge_cases', 'ai_broken'], w(['outlier', 'meta_rejected'])), [{ problem: 'edge_cases', caught: true }]);
});
