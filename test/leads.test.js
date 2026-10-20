import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRng } from '../lib/rng.js';
import { generateLeads, normalisePhone, normaliseEmail, inPeriod, joinPages } from '../lib/leads.js';

const W = new Date('2026-10-12T00:00:00Z');
const DAY = 864e5;

test('clean scenario: 6-12 leads, all in period, no flags', () => {
  for (let s = 0; s < 50; s++) for (const c of ['clinic', 'store']) {
    const l = generateLeads(c, [], makeRng(s), W);
    assert.ok(l.length >= 6 && l.length <= 12, `count ${l.length}`);
    assert.ok(l.every(x => inPeriod(x, W) && x.flags.length === 0));
  }
});

test('every lead has the Lead shape and unique id', () => {
  const l = generateLeads('store', ['edge_cases', 'duplicates'], makeRng(4), W);
  assert.equal(new Set(l.map(x => x.id)).size, l.length);
  for (const x of l) {
    assert.ok(['converted', 'cancelled', 'open'].includes(x.outcome));
    assert.equal(typeof x.value, 'number');
    assert.ok(x.source === null || typeof x.source === 'string');
  }
});

test('clean leads always have a source; some are organic over many seeds', () => {
  let organic = 0;
  for (let s = 0; s < 50; s++) for (const x of generateLeads('clinic', [], makeRng(s), W)) {
    assert.ok(x.source); if (x.source === 'organic') organic++;
  }
  assert.ok(organic > 0);
});

test('phone and email normalise to the same key', () => {
  assert.equal(normalisePhone('+961 70 123 456'), normalisePhone('070123456'));
  assert.equal(normalisePhone('00961-70-123456'), normalisePhone('70 123 456'));
  assert.equal(normaliseEmail('  Sara@Mail.COM '), 'sara@mail.com');
});

test('period is half-open', () => {
  assert.ok(inPeriod({ createdAt: new Date(+W + 7 * DAY - 1).toISOString() }, W));
  assert.ok(!inPeriod({ createdAt: new Date(+W + 7 * DAY).toISOString() }, W));
  assert.ok(!inPeriod({ createdAt: new Date(+W - 1).toISOString() }, W));
});

test('missing_source leaves leads with null source and the flag', () => {
  const l = generateLeads('clinic', ['missing_source'], makeRng(9), W);
  const m = l.filter(x => x.flags.includes('missing_source'));
  assert.ok(m.length >= 1 && m.length <= 3);
  assert.ok(m.every(x => x.source === null));
});

test('duplicates are reformatted copies that normalise equal', () => {
  const l = generateLeads('store', ['duplicates'], makeRng(9), W);
  const d = l.filter(x => x.flags.includes('duplicates'));
  assert.ok(d.length >= 1 && d.length <= 2);
  for (const x of d) {
    const orig = l.find(o => o !== x && !o.flags.includes('duplicates') && normaliseEmail(o.email) === normaliseEmail(x.email));
    assert.ok(orig, 'original exists');
    assert.notEqual(orig.email, x.email);
    assert.notEqual(orig.phone, x.phone);
    assert.equal(normalisePhone(orig.phone), normalisePhone(x.phone));
  }
});

test('edge cases: arabic and emoji names, a cancelled conversion, boundary pair', () => {
  const l = generateLeads('store', ['edge_cases'], makeRng(5), W);
  assert.ok(l.some(x => /[\u0600-\u06FF]/.test(x.firstName + x.lastName)));
  assert.ok(l.some(x => /\p{Extended_Pictographic}/u.test(x.firstName + x.lastName)));
  assert.ok(l.some(x => x.outcome === 'cancelled'));
  const b = l.filter(x => x.flags.includes('boundary'));
  assert.equal(b.length, 2);
  assert.equal(b.filter(x => inPeriod(x, W)).length, 1);
});

test('edge cases: store gets a 10x outlier order', () => {
  const l = generateLeads('store', ['edge_cases'], makeRng(5), W);
  const o = l.find(x => x.flags.includes('outlier'));
  assert.ok(o && o.outcome === 'converted');
  const others = l.filter(x => x.outcome === 'converted' && x !== o).map(x => x.value).sort((a, b) => a - b);
  assert.ok(others.length >= 2);
  assert.ok(o.value >= 5 * others[Math.floor(others.length / 2)]);
});

test('edge cases: clinic sometimes has zero leads', () => {
  let zero = 0;
  for (let s = 0; s < 40; s++) if (generateLeads('clinic', ['edge_cases'], makeRng(s), W).length === 0) zero++;
  assert.ok(zero > 0 && zero < 40);
});

test('edge cases: the same shared person appears at both clients', () => {
  const find = c => { for (let s = 0; s < 40; s++) { const l = generateLeads(c, ['edge_cases'], makeRng(s), W); if (l.length) return l; } };
  const a = find('clinic').find(x => x.flags.includes('shared'));
  const b = find('store').find(x => x.flags.includes('shared'));
  assert.ok(a && b);
  assert.equal(normaliseEmail(a.email), normaliseEmail(b.email));
});

test('all problems together never crash and keep every edge case', () => {
  const all = ['missing_source', 'duplicates', 'meta_mismatch', 'bad_totals', 'edge_cases'];
  for (let s = 0; s < 300; s++) for (const c of ['clinic', 'store']) {
    const l = generateLeads(c, all, makeRng(s), W);
    if (!l.length) continue;
    assert.ok(l.some(x => x.outcome === 'cancelled'), `seed ${s} ${c}`);
    assert.ok(l.some(x => x.flags.includes('shared')), `seed ${s} ${c}`);
    if (c === 'store') assert.ok(l.some(x => x.flags.includes('outlier')));
  }
});

test('joinPages: joins pages, drops repeats, flags a cut-off list, refuses a failed page', () => {
  const page = (...ids) => ({ statusCode: 200, body: { contacts: ids.map(id => ({ id })) } });
  assert.deepEqual(joinPages([page('a', 'b'), page('b', 'c'), page('d')], 'contacts', 10, 2), { rows: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }], more: false });
  assert.equal(joinPages([page('a', 'b'), page('c', 'd')], 'contacts', 2, 2).more, true);
  assert.equal(joinPages([page('a', 'b'), page('c')], 'contacts', 2, 2).more, false);
  assert.equal(joinPages([page('a', 'b'), { statusCode: 429, body: {} }], 'contacts', 10, 2), null);
  assert.equal(joinPages([], 'contacts', 10, 2), null);
  assert.deepEqual(joinPages([{ statusCode: 200, body: {} }], 'contacts', 10, 2).rows, []);
});
