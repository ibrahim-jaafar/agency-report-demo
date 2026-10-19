import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { makeRng } from '../lib/rng.js';
import { generateLeads } from '../lib/leads.js';
import { hashField, cleanName, buildMetaEvents } from '../lib/meta.js';

const sha = s => createHash('sha256').update(s, 'utf8').digest('hex');
const W = new Date('2026-10-12T00:00:00Z');
const NOW = Math.floor(Date.parse('2026-10-19T12:00:00Z') / 1000);
const T = '2026-10-13T10:00:00.000Z';
let n = 0;
const lead = (o) => ({ id: `l${n++}`, firstName: 'Sara', lastName: 'Haddad', email: 'Sara@Mail.com', phone: '+961 70 123 456', source: 'Ads', createdAt: T, outcome: 'converted', value: 120, flags: [], ...o });

test('hash normalises before hashing', () => assert.equal(hashField('  Sara@Mail.COM ', sha), sha('sara@mail.com')));
test('empty values are omitted', () => { assert.equal(hashField('  ', sha), undefined); assert.equal(hashField(null, sha), undefined); });
test('arabic and emoji names hash without throwing', () => {
  assert.match(hashField('سارة', sha), /^[0-9a-f]{64}$/);
  assert.match(hashField('Zoë 🌸', sha), /^[0-9a-f]{64}$/);
});

test('one event per non-cancelled conversion, with hashed user data', () => {
  const { events, edgeEvents, skipped } = buildMetaEvents('clinic', [lead(), lead({ outcome: 'cancelled' }), lead({ outcome: 'open' })], [], NOW, sha);
  assert.equal(events.length, 1);
  assert.deepEqual(edgeEvents, []);
  assert.equal(skipped, 0);
  const e = events[0];
  assert.equal(e.event_name, 'Schedule');
  assert.equal(e.action_source, 'system_generated');
  assert.equal(e.event_time, NOW);
  assert.deepEqual(e.user_data.em, [sha('sara@mail.com')]);
  assert.deepEqual(e.user_data.ph, [sha('96170123456')]);
  assert.equal(e.custom_data, undefined);
});

test('store events are purchases with value and currency', () => {
  const e = buildMetaEvents('store', [lead({ value: 250 })], [], NOW, sha).events[0];
  assert.equal(e.event_name, 'Purchase');
  assert.deepEqual(e.custom_data, { value: 250, currency: 'USD' });
});

test('no raw personal data in events', () => {
  const leads = generateLeads('store', ['edge_cases'], makeRng(3), W);
  const s = JSON.stringify(buildMetaEvents('store', leads, ['edge_cases'], NOW, sha));
  for (const l of leads) for (const v of [l.email, l.firstName, l.lastName, l.phone]) assert.ok(!s.includes(v), v);
});

test('event ids are unique and match the leads', () => {
  const leads = [lead(), lead(), lead()];
  const ids = buildMetaEvents('clinic', leads, [], NOW, sha).events.map(e => e.event_id);
  assert.deepEqual(ids, leads.map(l => l.id));
});

test('meta_mismatch leaves some conversions out', () => {
  const r1 = buildMetaEvents('clinic', [lead()], ['meta_mismatch'], NOW, sha);
  assert.equal(r1.events.length, 0); assert.equal(r1.skipped, 1);
  const r3 = buildMetaEvents('clinic', [lead(), lead(), lead()], ['meta_mismatch'], NOW, sha);
  assert.equal(r3.events.length, 1); assert.equal(r3.skipped, 2);
});

test('edge_cases adds one extra event dated 10 days ago, separate from the real ones', () => {
  const { events, edgeEvents } = buildMetaEvents('store', [lead()], ['edge_cases'], NOW, sha);
  assert.equal(events.length, 1);
  assert.equal(edgeEvents.length, 1);
  assert.equal(edgeEvents[0].event_time, NOW - 10 * 86400);
  assert.ok(!events.some(e => e.event_id === edgeEvents[0].event_id));
});

test('names lose punctuation and symbols before hashing, letters in any alphabet stay', () => {
  assert.equal(cleanName("O'Brien-Smith"), 'OBrienSmith');
  assert.equal(cleanName('Bloom 🌸'), 'Bloom ');
  assert.equal(cleanName('Zoë'), 'Zoë');
  assert.equal(cleanName('سارة'), 'سارة');
  const e = buildMetaEvents('clinic', [lead({ firstName: "D'Arcy", lastName: 'Bloom 🌸' })], [], NOW, sha).events[0];
  assert.deepEqual(e.user_data.fn, [sha('darcy')]);
  assert.deepEqual(e.user_data.ln, [sha('bloom')]);
});
