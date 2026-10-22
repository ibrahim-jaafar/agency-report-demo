import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport } from '../lib/report.js';

const W = new Date('2026-10-12T00:00:00Z');
const kc = { spend: 100, leads: 10, paidLeads: 8, costPerLead: 12.5, cancelled: 0, bookings: 3, costPerBooking: 33.33, bookingRate: 0.3 };
const ks = { spend: 200, leads: 8, paidLeads: 8, costPerLead: 25, cancelled: 0, orders: 2, revenue: 400, roas: 2, costPerOrder: 100, avgOrderValue: 200 };
const steps = (failed) => ['ghl', 'spend', 'meta', 'checks'].map(key => ({ key, status: key === failed ? 'failed' : 'done', ...(key === failed ? { reason: 'down' } : {}) }));
const clients = (wc = [], ws = [], prev = null) => [
  { client: 'clinic', name: 'Lumière Skin Clinic', kpis: kc, previousKpis: prev, warnings: wc },
  { client: 'store', name: 'Northwind Home', kpis: ks, previousKpis: null, warnings: ws }];
const base = (o = {}) => buildReport({ runId: 'r1', weekStart: W, clients: clients(), steps: steps(), problems: [], ...o });

test('clean run: both green, not partial, no AI text (the dashboard asks for that per period)', () => {
  const r = base({ asOf: '2026-10-18T15:00:00.000Z' });
  assert.equal(r.partial, false);
  assert.deepEqual(r.clients.map(c => c.light), ['green', 'green']);
  assert.ok(!('summary' in r.clients[0]) && !('overview' in r));
  assert.equal(r.weekStart, W.toISOString());
  assert.equal(r.asOf, '2026-10-18T15:00:00.000Z');
  assert.equal(r.ranAt, r.asOf);
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

test('injected problems: caught or missed', () => {
  const r = base({ problems: ['duplicates', 'bad_totals'], clients: clients([], [{ code: 'duplicates', count: 1, message: 'm' }]) });
  assert.deepEqual(r.injected, [{ problem: 'duplicates', caught: true }, { problem: 'bad_totals', caught: false }]);
});

test('meta_mismatch with nothing to skip is not applicable, not missed', () => {
  assert.deepEqual(base({ problems: ['meta_mismatch'], metaSkipped: 0 }).injected, [{ problem: 'meta_mismatch', caught: null }]);
  assert.deepEqual(base({ problems: ['meta_mismatch'], metaSkipped: 2 }).injected, [{ problem: 'meta_mismatch', caught: false }]);
});

test('alertText: nothing when all is well; failed steps and warnings when not', async () => {
  const { alertText } = await import('../lib/report.js');
  const ok = buildReport({ runId: 'r', weekStart: W, clients: clients(), steps: steps(), problems: [] });
  assert.equal(alertText(ok, 'L'), null);
  const w = { code: 'duplicates', count: 2, message: '2 leads look like duplicates' };
  const bad = buildReport({ runId: 'r', weekStart: W, asOf: '2026-10-18T15:00:00Z', clients: clients([w]), steps: steps('meta'), problems: ['duplicates'] });
  const t = alertText(bad, 'L').split('\n');
  assert.match(t[0], /Report for the 7 days to 2026-10-18 needs a look \(demo: the visitor chose/);
  assert.equal(t[1], '• Sending conversions to Meta failed: down');
  assert.match(t[2], /^• .+: 2 leads look like duplicates$/);
  assert.equal(t.at(-1), 'Report: L');
  const real = buildReport({ runId: 'r', weekStart: W, clients: clients([w]), steps: steps(), problems: [] });
  assert.doesNotMatch(alertText(real, 'L'), /demo/);
});

test('each client carries its campaigns, or null when it has none', () => {
  const camps = [{ name: 'Botox Spring', spend: 50, paidLeads: 2, impressions: 4000, clicks: 60 }];
  const cs = clients();
  cs[0].campaigns = camps;
  const r = base({ clients: cs });
  assert.deepEqual(r.clients[0].campaigns, camps);
  assert.equal(r.clients[1].campaigns, null);
});

test('each client carries its days, or null when it has none', () => {
  const cs = clients();
  cs[0].days = [{ day: '2026-10-12', leads: 2 }];
  const r = base({ clients: cs });
  assert.deepEqual(r.clients[0].days, [{ day: '2026-10-12', leads: 2 }]);
  assert.equal(r.clients[1].days, null);
});

test('each client carries its leads list, or null', () => {
  const cs = clients();
  cs[0].leadList = [{ name: 'Sara H.', source: 'Ads', outcome: 'open', value: 0, createdAt: '2026-10-13T10:00:00.000Z', duplicate: false }];
  const r = base({ clients: cs });
  assert.equal(r.clients[0].leadList[0].name, 'Sara H.');
  assert.equal(r.clients[1].leadList, null);
});

// ---------- test leads ----------
import { addTestLead } from '../lib/report.js';
import { testLead, generateLeads } from '../lib/leads.js';
import { makeRng } from '../lib/rng.js';
import { simulateSpend } from '../lib/spend.js';
import { runDays, leadList, periodFigures } from '../lib/daily.js';

test('a test lead arrives now and joins the latest run: its list, today’s figures and how far today goes', () => {
  const start = new Date('2026-10-16T00:00:00Z'), ranAt = '2026-10-22T10:00:00.000Z';
  const leads = generateLeads('clinic', [], makeRng(2), start, Date.parse(ranAt)), spend = simulateSpend('clinic', leads, [], makeRng(2));
  const report = { weekStart: start.toISOString(), asOf: ranAt, clients: [{ client: 'clinic', days: runDays('clinic', leads, spend, start), leadList: leadList(leads, start), light: 'green' }] };
  const now = Date.parse('2026-10-22T15:30:00Z');
  for (let s = 0; s < 30; s++) {
    const t = testLead('clinic', makeRng(s), now);
    assert.equal(t.createdAt, '2026-10-22T15:30:00.000Z');
    const r = addTestLead(report, 'clinic', t, false);
    const seen = new Date(now + 5000); // the page shows it a moment later
    const before = periodFigures('clinic', { ...report.clients[0], asOf: report.asOf }, 'day', seen);
    const after = periodFigures('clinic', { ...r.clients[0], asOf: r.asOf }, 'day', seen);
    assert.equal(after.kpis.leads, before.kpis.leads + 1);
    assert.equal(after.leads[0].createdAt, t.createdAt);
    assert.equal(r.asOf, '2026-10-22T15:30:01.000Z');
    // a conversion Meta didn't take shows up in data health
    if (t.outcome === 'converted') assert.ok(after.health.warnings.some(w => w.code === 'meta_mismatch'));
    assert.equal(r.testLeads, 1);
  }
  // the report it came from is left as it was
  assert.equal(report.asOf, ranAt);
  // a run that doesn't cover today can't take one
  assert.throws(() => addTestLead(report, 'clinic', testLead('clinic', makeRng(1), Date.parse('2026-10-24T09:00:00Z')), true), /no 2026-10-24/);
});
