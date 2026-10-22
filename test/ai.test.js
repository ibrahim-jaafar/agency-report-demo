import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRng } from '../lib/rng.js';
import { generateLeads } from '../lib/leads.js';
import { simulateSpend } from '../lib/spend.js';
import { computeKpis } from '../lib/kpis.js';
import { runChecks } from '../lib/checks.js';
import { AI_SCHEMA, LABELS, COUNT_LABELS, placeholderGuide, buildAiInput, validateAiOutput, pickAiAnswer, templateDraft, templateSummary, placeholderValues, periodWords } from '../lib/ai.js';

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
    { client: 'clinic', headline: '{leads} leads and {bookings} booked consultations', summary: 'Leads were {leads_change} on the previous report, at {costPerLead} per lead. Booking rate was {bookingRate}.', warnings_explained: ['{missing_source_count} leads have no source.'], next_steps: ['Fix lead source tagging.'] },
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
  assert.equal(r.value.clients[0].summary, 'Leads were up 16% on the previous report, at $24.80 per lead. Booking rate was 24.1%.');
  assert.equal(r.value.clients[1].headline, '$4,820.00 revenue from 12 orders');
});

test('pickAiAnswer takes the first reply that passes, and says why the others failed', () => {
  const reply = v => ({ statusCode: 200, body: { choices: [{ message: { content: JSON.stringify(v) } }] } });
  const typed = structuredClone(good); typed.clients[0].summary = 'There were 58 leads.';
  const p = pickAiAnswer([reply(typed), reply(good)], input);
  assert.equal(p.value.clients[0].headline, '58 leads and 14 booked consultations');
  assert.match(p.errors[0], /types a number/);
  const none = pickAiAnswer([{ error: { message: 'timeout' } }, { statusCode: 503, body: {} }], input);
  assert.deepEqual([none.value, none.gotAnswer, none.errors], [null, false, ['AI service timed out', 'AI service answered 503']]);
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
  assert.match(t.clients[0].headline + t.clients[0].summary, /no leads last week/i);
  assert.ok(!/NaN|Infinity|null|undefined/.test(JSON.stringify(t)));
  // a period still under way says so
  const now = templateSummary({ ...z, period: periodWords('month', 0, 'week', '2026-10-01') });
  assert.equal(now.clients[0].headline, 'No leads this month so far');
});

test('periods are named in words, never digits, and say when they are not over', () => {
  const all = [];
  for (const period of ['day', 'week', 'month', 'year']) for (const back of [0, 1, 2]) for (const vs of ['week', 'prev']) {
    const w = periodWords(period, back, vs, '2026-09-01');
    all.push(w);
    assert.ok(!/\d/.test(w.covers + w.vs), JSON.stringify(w));
    assert.equal(w.finished, back > 0);
  }
  assert.deepEqual(periodWords('day', 0, 'week', '2026-10-22'), { covers: 'today so far', vs: 'last Thursday up to the same time', finished: false });
  assert.deepEqual(periodWords('month', 1, 'week', '2026-09-01'), { covers: 'in September', vs: 'the month before', finished: true });
  // the template's comparison follows the period
  const t = templateSummary({ ...input, period: periodWords('year', 0, 'week', '2026-01-01') });
  assert.match(JSON.stringify(t), /compared with the same days last year/);
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

test('every number must sit next to its own label', () => {
  const check = text => { const o = structuredClone(good); o.clients[0].summary = text; return validateAiOutput(o, input); };
  for (const text of [
    'Cost per booking was {costPerLead}.', // a real number under the wrong label
    'Cost per lead was {leads}.', // a count right after a cost label
    'Bookings came in at {leads} this week.',
    'Return on ad spend was {spend}.',
    'Leads came to {leads}, and the cost per booking was {costPerLead}.', // each placeholder looks only at its own words
    'Things went well: {leads}.',
    'Cost per lead was {costPerLead} and cost per booking was {costPerLead_change}.',
  ]) assert.equal(check(text).ok, false, text);
  for (const text of [
    'Cost per lead was {costPerLead}, and cost per booking was {costPerBooking}.',
    '{leads} leads came in, {paidLeads} of them paid leads.',
    'Leads were {leads_change} on the previous report.',
    'Your booking rate was {bookingRate}, and {bookings} consultations were booked.',
    'Keep an eye on the cost per lead, which is currently {costPerLead}.',
    'There are {missing_source_count} leads that do not show where they came from.',
    '{missing_source_message}',
  ]) assert.equal(check(text).ok, true, `${text}: ${check(text).errors}`);
});

test('every KPI and warning has a label, and the AI guide shows each one', () => {
  const kpis = ['spend', 'leads', 'paidLeads', 'costPerLead', 'cancelled', 'bookings', 'costPerBooking', 'bookingRate', 'orders', 'revenue', 'roas', 'costPerOrder', 'avgOrderValue'];
  assert.deepEqual(Object.keys(LABELS).sort(), [...kpis].sort());
  assert.deepEqual(Object.keys(COUNT_LABELS).sort(), ['bad_totals', 'duplicates', 'meta_mismatch', 'meta_rejected', 'missing_source', 'outlier']);
  const guide = placeholderGuide();
  for (const k of [...kpis, ...Object.keys(COUNT_LABELS).map(c => `${c}_count`)]) assert.ok(guide.includes(`{${k}}:`), k);
  // the guide's own examples must pass the check it describes (other errors, like a number with no value for this client, don't matter here)
  for (const l of [...Object.values(LABELS), ...Object.values(COUNT_LABELS)]) {
    const o = structuredClone(good); o.clients[0].summary = l.example;
    const errors = validateAiOutput(o, input).errors || [];
    assert.deepEqual(errors.filter(e => /near it|right after/.test(e)), [], l.example);
  }
});

test('return on ad spend reads with its ×', () => {
  const v = placeholderValues({ kpis: { roas: 3.21 }, changes: null, warnings: [] });
  assert.equal(v.roas, '3.21×');
});

test('when the AI gives no answer, the reason says which: a status, a timeout, or nothing', () => {
  assert.deepEqual(pickAiAnswer([{ statusCode: 503, body: {} }], input).errors, ['AI service answered 503']);
  assert.deepEqual(pickAiAnswer([{ error: { message: 'timeout of 45000ms exceeded' } }], input).errors, ['AI service timed out']);
  assert.deepEqual(pickAiAnswer([{}], input).errors, ['AI service answered nothing']);
});
