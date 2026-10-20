import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRng } from '../lib/rng.js';
import { generateLeads } from '../lib/leads.js';
import { simulateSpend } from '../lib/spend.js';
import { computeKpis } from '../lib/kpis.js';
import { runChecks } from '../lib/checks.js';
import { AI_SCHEMA, buildAiInput, validateAiOutput, pickAiAnswer, templateDraft, templateSummary } from '../lib/ai.js';

const W = new Date('2026-10-12T00:00:00Z');
const NAMES = { clinic: 'Lumière Skin Clinic', store: 'Northwind Home' };

function sample(seed, problems = []) {
  return buildAiInput(['clinic', 'store'].map(client => {
    const leads = generateLeads(client, problems, makeRng(seed), W);
    const spend = simulateSpend(client, leads, problems, makeRng(seed));
    const kpis = computeKpis(client, leads, spend, W);
    const conv = leads.filter(l => l.outcome === 'converted').length;
    return { client, name: NAMES[client], kpis, previousKpis: seed % 2 ? kpis : null,
      warnings: runChecks({ client, leads, spend, meta: { sent: conv, accepted: conv, rejected: 0 }, weekStart: W }), leads };
  }));
}

const input = buildAiInput([
  { client: 'clinic', name: 'Lumière Skin Clinic', kpis: { spend: 1240, leads: 58, paidLeads: 50, costPerLead: 24.8, cancelled: 0, bookings: 14, costPerBooking: 88.57, bookingRate: 0.2414 },
    previousKpis: { spend: 1100, leads: 50, paidLeads: 44, costPerLead: 25, cancelled: 0, bookings: 10, costPerBooking: 110, bookingRate: 0.2 },
    warnings: [{ code: 'missing_source', count: 3, message: '3 leads have no recorded source, so we can\'t tell which ad brought them.' }] },
  { client: 'store', name: 'Northwind Home', kpis: { spend: 1500, leads: 40, paidLeads: 35, costPerLead: 42.86, cancelled: 1, orders: 12, revenue: 4820, roas: 3.21, costPerOrder: 125, avgOrderValue: 401.67 },
    previousKpis: null, warnings: [] },
]);

const good = {
  overview: 'Both clients are on track; the clinic needs a source clean-up.',
  clients: [
    { client: 'clinic', headline: '{leads} leads and {bookings} booked consultations', summary: 'Leads were {leads_change} on the previous report, at {costPerLead} each. Booking rate was {bookingRate}.', warnings_explained: ['{missing_source_count} leads have no source.'], next_steps: ['Fix lead source tagging.'] },
    { client: 'store', headline: '{revenue} revenue from {orders} orders', summary: 'Return on ad spend was {roas} on {spend} of spend.', warnings_explained: [], next_steps: [] },
  ],
};

test('schema is strict', () => {
  assert.equal(AI_SCHEMA.additionalProperties, false);
  assert.equal(AI_SCHEMA.properties.clients.items.additionalProperties, false);
  assert.equal(AI_SCHEMA.properties.clients.minItems, 2);
});

test('input carries no personal fields even when leads are passed in', () => {
  const s = JSON.stringify(sample(4, ['edge_cases', 'duplicates']));
  for (const k of ['email', 'phone', 'firstName', 'lastName', '@example.com', 'سارة']) assert.ok(!s.includes(k), k);
});

test('input includes % changes vs previous, null when previous is missing or zero', () => {
  assert.equal(input.clients[0].changes.leads, 16);
  assert.equal(input.clients[1].changes, null);
  const z = buildAiInput([{ client: 'clinic', name: 'X', kpis: { leads: 5 }, previousKpis: { leads: 0 }, warnings: [] }]);
  assert.equal(z.clients[0].changes.leads, null);
});

test('input lists each placeholder with the value the reader will see', () => {
  const p = input.clients[0].placeholders;
  assert.equal(p.leads, '58');
  assert.equal(p.costPerLead, '$24.80');
  assert.equal(p.bookingRate, '24.1%');
  assert.equal(p.leads_change, 'up 16%');
  assert.equal(p.costPerLead_change, 'down 1%');
  assert.equal(p.missing_source_count, '3');
  assert.equal(input.clients[1].placeholders.revenue, '$4,820.00');
  assert.ok(!('leads_change' in input.clients[1].placeholders), 'no previous report, so no change');
});

test('accepts a correct answer, as object or JSON string, and fills in the real numbers', () => {
  const r = validateAiOutput(good, input);
  assert.equal(r.ok, true);
  assert.equal(validateAiOutput(JSON.stringify(good), input).ok, true);
  assert.equal(r.value.clients[0].headline, '58 leads and 14 booked consultations');
  assert.equal(r.value.clients[0].summary, 'Leads were up 16% on the previous report, at $24.80 each. Booking rate was 24.1%.');
  assert.equal(r.value.clients[1].headline, '$4,820.00 revenue from 12 orders');
});

test('pickAiAnswer takes the first reply that passes, and says why the others failed', () => {
  const reply = v => ({ statusCode: 200, body: { choices: [{ message: { content: JSON.stringify(v) } }] } });
  const typed = structuredClone(good); typed.clients[0].summary = 'There were 58 leads.';
  const p = pickAiAnswer([reply(typed), reply(good)], input);
  assert.equal(p.value.clients[0].headline, '58 leads and 14 booked consultations');
  assert.match(p.errors[0], /types a number/);
  const none = pickAiAnswer([{ error: { message: 'timeout' } }, { statusCode: 503, body: {} }], input);
  assert.deepEqual([none.value, none.gotAnswer, none.errors], [null, false, ['AI service answered nothing', 'AI service answered 503']]);
  const broken = pickAiAnswer([reply(good)], input, true);
  assert.equal(broken.value, null);
  assert.equal(broken.gotAnswer, true, 'the AI answered; the demo swapped it for a refusal');
});

test('rejects invalid JSON, prose, missing keys, extra keys, wrong client count, duplicate clients', () => {
  const bad = [
    'not json', 'Sure! Here is the report: {}', '{"overview":"x"}',
    { ...good, extra: 1 },
    { ...good, clients: [good.clients[0]] },
    { ...good, clients: [good.clients[0], good.clients[0]] },
    { ...good, clients: [{ ...good.clients[0], mood: 'happy' }, good.clients[1]] },
    { ...good, overview: 'x'.repeat(201) },
    { ...good, clients: [{ ...good.clients[0], next_steps: ['a', 'b', 'c', 'd'] }, good.clients[1]] },
    null, 42,
  ];
  for (const b of bad) assert.equal(validateAiOutput(b, input).ok, false, JSON.stringify(b)?.slice(0, 80));
});

test('rejects any number the AI types itself, even a correct one', () => {
  for (const text of ['Leads rose to 999.', 'There were 58 leads.', 'Cost per lead was $24.80.']) {
    const o = structuredClone(good);
    o.clients[0].summary = text;
    const r = validateAiOutput(o, input);
    assert.equal(r.ok, false, text);
    assert.match(r.errors.join(' '), /types a number/);
  }
  const o = structuredClone(good);
  o.overview = 'Both clients had {leads} leads.';
  assert.equal(validateAiOutput(o, input).ok, false, 'the overview has no placeholders');
});

test('length limits apply to the text the reader sees, not to the placeholders', () => {
  const o = structuredClone(good);
  o.clients[0].summary = 'Cost per booking was {costPerBooking_change} on the previous report. '.repeat(9); // 621 characters as written, under 600 filled
  assert.equal(validateAiOutput(o, input).ok, true);
  o.clients[0].summary = 'Cost per lead was {costPerLead}, a good week. '.repeat(16); // over 600 filled
  assert.match(validateAiOutput(o, input).errors.join(' '), /too long/);
});

test('rejects unknown placeholders, and ones with no value this week', () => {
  for (const [i, text] of [[0, 'Profit was {profit}.'], [1, 'Revenue was {revenue_change}.'], [0, 'Revenue was {revenue}.']]) {
    const o = structuredClone(good);
    o.clients[i].summary = text;
    const r = validateAiOutput(o, input);
    assert.equal(r.ok, false, text);
    assert.match(r.errors.join(' '), /has no value/);
  }
});

test('rejects up/down words next to a change, which already says it', () => {
  for (const text of ['Leads rose {leads_change}.', 'Leads fell by {leads_change}.', 'Leads were down {leads_change}.']) {
    const o = structuredClone(good);
    o.clients[0].summary = text;
    assert.equal(validateAiOutput(o, input).ok, false, text);
  }
});

test('template follows the same placeholder rules, for every kind of week', () => {
  for (let s = 0; s < 40; s++) for (const p of [[], ['edge_cases'], ['missing_source', 'duplicates', 'bad_totals', 'edge_cases']]) {
    const inp = sample(s, p);
    const r = validateAiOutput(templateDraft(inp), inp);
    assert.equal(r.ok, true, `seed ${s} ${p}: ${r.errors}`);
    const t = templateSummary(inp);
    const texts = [t.overview, ...t.clients.flatMap(c => [c.headline, c.summary, ...c.warnings_explained, ...c.next_steps])].join(' ');
    assert.ok(!/[{}]|NaN|Infinity|null|undefined/.test(texts), `seed ${s} ${p}: ${texts}`);
  }
  assert.equal(validateAiOutput(templateDraft(input), input).ok, true);
  assert.deepEqual(templateSummary(input).clients[0].warnings_explained, [input.clients[0].warnings[0].message]);
});

test('template says "no leads yet" instead of printing nothing-numbers', () => {
  const z = buildAiInput([
    { client: 'clinic', name: 'Lumière Skin Clinic', kpis: computeKpis('clinic', [], { campaigns: [{ name: 'a', spend: 20, paidLeads: 0 }], reportedTotal: 20 }, W), previousKpis: null, warnings: [] },
    { client: 'store', name: 'Northwind Home', kpis: input.clients[1].kpis, previousKpis: null, warnings: [] },
  ]);
  const t = templateSummary(z);
  assert.match(t.clients[0].headline + t.clients[0].summary, /no leads yet/i);
  assert.ok(!/NaN|Infinity|null|undefined/.test(JSON.stringify(t)));
});

test('template uses singular words for one', () => {
  const one = { clients: [
    { client: 'clinic', name: 'C', kpis: { spend: 50, leads: 1, paidLeads: 1, costPerLead: 50, cancelled: 1, bookings: 1, costPerBooking: 50, bookingRate: 1 }, changes: null, warnings: [] },
    { client: 'store', name: 'S', kpis: { spend: 50, leads: 1, paidLeads: 1, costPerLead: 50, cancelled: 1, orders: 1, revenue: 82, roas: 1.64, costPerOrder: 50, avgOrderValue: 82 }, changes: null, warnings: [] }] };
  const t = templateSummary(one);
  const text = JSON.stringify(t);
  for (const bad of ['1 orders', '1 leads', '1 booked consultations', '1 cancelled bookings', '1 cancelled orders']) assert.ok(!text.includes(bad), bad);
  assert.match(t.clients[1].headline, /from 1 order$/);
});
