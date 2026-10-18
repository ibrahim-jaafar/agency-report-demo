import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport } from '../lib/report.js';

const W = new Date('2026-10-12T00:00:00Z');
const kc = { spend: 100, leads: 10, paidLeads: 8, costPerLead: 12.5, cancelled: 0, bookings: 3, costPerBooking: 33.33, bookingRate: 0.3 };
const ks = { spend: 200, leads: 8, paidLeads: 8, costPerLead: 25, cancelled: 0, orders: 2, revenue: 400, roas: 2, costPerOrder: 100, avgOrderValue: 200 };
const steps = (failed) => ['ghl', 'spend', 'meta', 'checks', 'ai'].map(key => ({ key, status: key === failed ? 'failed' : 'done', ...(key === failed ? { reason: 'down' } : {}) }));
const ai = (source = 'ai') => ({ source, value: { overview: 'ov', clients: [
  { client: 'clinic', headline: 'h1', summary: 's1', warnings_explained: [], next_steps: [] },
  { client: 'store', headline: 'h2', summary: 's2', warnings_explained: [], next_steps: [] }] } });
const clients = (wc = [], ws = [], prev = null) => [
  { client: 'clinic', name: 'Lumière Skin Clinic', kpis: kc, previousKpis: prev, warnings: wc },
  { client: 'store', name: 'Northwind Home', kpis: ks, previousKpis: null, warnings: ws }];
const base = (o = {}) => buildReport({ runId: 'r1', weekStart: W, clients: clients(), steps: steps(), ai: ai(), problems: [], ...o });

test('clean run: both green, not partial, summaries attached', () => {
  const r = base();
  assert.equal(r.partial, false);
  assert.deepEqual(r.clients.map(c => c.light), ['green', 'green']);
  assert.equal(r.clients[0].summary.headline, 'h1');
  assert.equal(r.overview, 'ov');
  assert.equal(r.aiSource, 'ai');
  assert.equal(r.weekStart, W.toISOString());
});

test('warnings make a client orange', () => {
  const r = base({ clients: clients([], [{ code: 'duplicates', count: 1, message: 'm' }]) });
  assert.deepEqual(r.clients.map(c => c.light), ['green', 'orange']);
});

test('a failed data step makes both red and the report partial', () => {
  const r = base({ steps: steps('meta') });
  assert.equal(r.partial, true);
  assert.deepEqual(r.clients.map(c => c.light), ['red', 'red']);
});

test('a failed AI step is partial but lights stay data-driven', () => {
  const r = base({ steps: steps('ai'), ai: ai('template') });
  assert.equal(r.partial, true);
  assert.deepEqual(r.clients.map(c => c.light), ['green', 'green']);
});

test('changes vs previous; null when previous missing or zero', () => {
  const r = base({ clients: clients([], [], { ...kc, leads: 8, bookings: 0 }) });
  assert.equal(r.clients[0].changes.leads, 25);
  assert.equal(r.clients[0].changes.bookings, null);
  assert.equal(r.clients[1].changes, null);
});

test('injected problems: caught or missed, ai_broken from the AI source', () => {
  const r = base({ problems: ['duplicates', 'bad_totals', 'ai_broken'], ai: ai('template'),
    clients: clients([], [{ code: 'duplicates', count: 1, message: 'm' }]) });
  assert.deepEqual(r.injected, [{ problem: 'duplicates', caught: true }, { problem: 'bad_totals', caught: false }, { problem: 'ai_broken', caught: true }]);
  assert.equal(base({ problems: ['ai_broken'] }).injected[0].caught, false);
});

test('meta_mismatch with nothing to skip is not applicable, not missed', () => {
  assert.deepEqual(base({ problems: ['meta_mismatch'], metaSkipped: 0 }).injected, [{ problem: 'meta_mismatch', caught: null }]);
  assert.deepEqual(base({ problems: ['meta_mismatch'], metaSkipped: 2 }).injected, [{ problem: 'meta_mismatch', caught: false }]);
});
