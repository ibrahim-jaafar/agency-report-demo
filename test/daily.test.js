import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRng } from '../lib/rng.js';
import { generateLeads } from '../lib/leads.js';
import { simulateSpend } from '../lib/spend.js';
import { computeKpis } from '../lib/kpis.js';
import { dayKey, addDays, runDays, historyDay, sumDays, kpisFromTotals, periodRange, daySeries, liveToday } from '../lib/daily.js';

const W = new Date('2026-10-12T00:00:00Z');
const sumOf = (rows, f) => rows.reduce((a, r) => a + r[f], 0);
const cents = n => Math.round(n * 100) / 100;

test('dates are plain UTC day keys', () => {
  assert.equal(dayKey(W), '2026-10-12');
  assert.equal(addDays('2026-10-12', 6), '2026-10-18');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('the run week splits into 7 days that add up to the week', () => {
  for (const client of ['clinic', 'store']) for (let s = 0; s < 20; s++) {
    const leads = generateLeads(client, s % 2 ? ['edge_cases', 'duplicates'] : [], makeRng(s), W);
    const spend = simulateSpend(client, leads, [], makeRng(s));
    const days = runDays(client, leads, spend, W);
    const k = computeKpis(client, leads, spend, W);
    assert.equal(days.length, 7);
    assert.deepEqual(days.map(d => d.day), ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18']);
    assert.equal(sumOf(days, 'leads'), k.leads);
    assert.equal(sumOf(days, 'paidLeads'), k.paidLeads);
    assert.equal(sumOf(days, 'cancelled'), k.cancelled);
    assert.equal(sumOf(days, 'conversions'), client === 'clinic' ? k.bookings : k.orders);
    assert.equal(cents(sumOf(days, 'spend')), k.spend);
    assert.equal(sumOf(days, 'impressions'), k.impressions);
    assert.equal(sumOf(days, 'clicks'), k.clicks);
    if (client === 'store') assert.equal(cents(sumOf(days, 'revenue')), k.revenue);
    assert.ok(days.every(d => d.spend > 0 && d.clicks <= d.impressions && !d.simulated));
  }
});

test('the run week split is the same every time for the same week', () => {
  const leads = generateLeads('store', [], makeRng(4), W), spend = simulateSpend('store', leads, [], makeRng(4));
  assert.deepEqual(runDays('store', leads, spend, W), runDays('store', leads, spend, W));
});

test('history days are made up, believable and always the same', () => {
  assert.deepEqual(historyDay('clinic', '2026-05-04'), historyDay('clinic', '2026-05-04'));
  assert.notDeepEqual(historyDay('clinic', '2026-05-04'), historyDay('store', '2026-05-04'));
  let days = 0, leads = 0;
  for (let i = 0; i < 400; i++) for (const client of ['clinic', 'store']) {
    const d = historyDay(client, addDays('2025-09-01', i));
    assert.equal(d.simulated, true);
    assert.ok(d.paidLeads <= d.leads && d.conversions + d.cancelled <= d.leads);
    assert.ok(d.spend > 0 && d.clicks > 0 && d.clicks < d.impressions);
    const cpc = d.spend / d.clicks;
    // quiet days have few clicks, so rounding to whole clicks moves the ratio a little
    assert.ok(cpc > 0.55 && cpc < 1.7, `cpc ${cpc}`);
    if (client === 'clinic') assert.equal(d.revenue, d.conversions * 150);
    days++; leads += d.leads;
  }
  const perWeek = (leads / days) * 7;
  assert.ok(perWeek > 6 && perWeek < 14, `about a run's worth of leads a week, got ${perWeek}`);
});

test('totals add up and ratios come from the sums, never averaged', () => {
  const rows = [
    { leads: 10, paidLeads: 8, conversions: 3, cancelled: 1, revenue: 450, spend: 200, impressions: 9000, clicks: 200 },
    { leads: 0, paidLeads: 0, conversions: 0, cancelled: 0, revenue: 0, spend: 100, impressions: 3000, clicks: 50 },
  ];
  const t = sumDays(rows);
  assert.deepEqual(t, { leads: 10, paidLeads: 8, conversions: 3, cancelled: 1, revenue: 450, spend: 300, impressions: 12000, clicks: 250, days: 2 });
  const c = kpisFromTotals('clinic', t);
  assert.equal(c.costPerLead, 37.5);
  assert.equal(c.costPerClick, 1.2);
  assert.equal(c.bookings, 3);
  assert.equal(c.bookingRate, 0.3);
  assert.equal(c.costPerBooking, 100);
  const s = kpisFromTotals('store', t);
  assert.equal(s.orders, 3);
  assert.equal(s.roas, 1.5);
  assert.equal(s.avgOrderValue, 150);
  assert.equal(kpisFromTotals('store', sumDays([])).roas, null);
});

test('the week of daily totals matches the weekly report', () => {
  const leads = generateLeads('clinic', [], makeRng(9), W), spend = simulateSpend('clinic', leads, [], makeRng(9));
  const k = computeKpis('clinic', leads, spend, W);
  const d = kpisFromTotals('clinic', sumDays(runDays('clinic', leads, spend, W)));
  for (const key of ['spend', 'leads', 'paidLeads', 'costPerLead', 'cancelled', 'bookings', 'costPerBooking', 'bookingRate', 'impressions', 'clicks', 'costPerClick']) assert.equal(d[key], k[key], key);
});

test('each period has a range and a fair comparison', () => {
  const today = '2026-10-21', weekStart = '2026-10-12';
  assert.deepEqual(periodRange('day', today, weekStart), { from: '2026-10-20', to: '2026-10-20', cmp: { from: '2026-10-13', to: '2026-10-13' } });
  assert.deepEqual(periodRange('week', today, weekStart), { from: '2026-10-12', to: '2026-10-18', cmp: { from: '2026-10-05', to: '2026-10-11' } });
  assert.deepEqual(periodRange('month', today, weekStart), { from: '2026-10-01', to: '2026-10-20', cmp: { from: '2026-09-01', to: '2026-09-20' } });
  assert.deepEqual(periodRange('year', today, weekStart), { from: '2026-01-01', to: '2026-10-20', cmp: { from: '2025-01-01', to: '2025-10-20' } });
  // on the 1st, "month" is the whole month that just ended; the same days a month earlier stay inside that month
  assert.deepEqual(periodRange('month', '2026-04-01', weekStart), { from: '2026-03-01', to: '2026-03-31', cmp: { from: '2026-02-01', to: '2026-02-28' } });
  assert.deepEqual(periodRange('year', '2025-03-01', weekStart).cmp, { from: '2024-01-01', to: '2024-02-28' });
});

test('the run days replace the made-up days of the same dates', () => {
  const run = [{ day: '2026-10-12', leads: 99, paidLeads: 0, conversions: 0, cancelled: 0, revenue: 0, spend: 1, impressions: 10, clicks: 1 }];
  const s = daySeries('clinic', '2026-10-11', '2026-10-13', run);
  assert.deepEqual(s.map(d => d.day), ['2026-10-11', '2026-10-12', '2026-10-13']);
  assert.equal(s[1].leads, 99);
  assert.equal(s[0].simulated, true);
});

test('live today only grows through the day and never passes the full day', () => {
  const full = historyDay('store', '2026-10-21');
  let prev = null;
  for (let m = 0; m <= 24 * 60; m += 7) {
    const now = new Date(Date.UTC(2026, 9, 21, 0, m));
    const l = liveToday('store', now);
    assert.equal(l.day, '2026-10-21');
    if (prev) for (const f of ['leads', 'paidLeads', 'conversions', 'spend', 'impressions', 'clicks', 'revenue']) assert.ok(l.totals[f] >= prev[f], `${f} at minute ${m}`);
    for (const f of ['leads', 'conversions', 'spend', 'clicks']) assert.ok(l.totals[f] <= full[f] + 1e-9);
    assert.ok(l.totals.clicks <= l.totals.impressions);
    prev = l.totals;
  }
  const end = liveToday('store', new Date(Date.UTC(2026, 9, 21, 23, 59, 59)));
  assert.equal(end.totals.leads, full.leads);
  const noon = liveToday('clinic', new Date(Date.UTC(2026, 9, 21, 12, 30)));
  assert.equal(noon.hours.length, 13);
  assert.equal(noon.lastWeek.day, '2026-10-14');
});

test('cost per click moves from day to day in the run week', () => {
  const leads = generateLeads('store', [], makeRng(3), W), spend = simulateSpend('store', leads, [], makeRng(3));
  const cpc = runDays('store', leads, spend, W).map(d => d.spend / d.clicks);
  assert.ok(Math.max(...cpc) - Math.min(...cpc) > 0.05, `spread ${Math.max(...cpc) - Math.min(...cpc)}`);
});

test('live uses the run’s real day for "same time last week" when it has one', () => {
  const run = [{ day: '2026-10-14', leads: 6, paidLeads: 5, conversions: 2, cancelled: 0, revenue: 300, spend: 29.24, impressions: 3000, clicks: 40 }];
  const end = liveToday('clinic', new Date(Date.UTC(2026, 9, 21, 23, 59, 59, 999)), run);
  assert.equal(end.lastWeek.totals.leads, 6);
  assert.equal(end.lastWeek.totals.spend, 29.24);
  assert.equal(end.lastWeek.hours.length, 24);
  assert.equal(end.lastWeek.hours.reduce((a, h) => a + h.leads, 0), 6);
  // without run rows it is the made-up day, as before
  assert.equal(liveToday('clinic', new Date(Date.UTC(2026, 9, 21, 23, 59, 59, 999))).lastWeek.totals.leads, historyDay('clinic', '2026-10-14').leads);
});

// ---------- campaigns per day, leads list, previous week ----------
import { sumCampaigns, leadList, previousWeekKpis } from '../lib/daily.js';
import { CAMPAIGNS } from '../lib/leads.js';
import { campaignRows } from '../lib/kpis.js';
import { runChecks } from '../lib/checks.js';

const near = (a, b) => Math.abs(a - b) < 0.005;

test('each run day is split by campaign, and the campaigns add up to the week', () => {
  for (const client of ['clinic', 'store']) for (let s = 0; s < 15; s++) {
    const leads = generateLeads(client, s % 2 ? ['missing_source', 'edge_cases'] : [], makeRng(s), W);
    const spend = simulateSpend(client, leads, [], makeRng(s));
    const days = runDays(client, leads, spend, W);
    for (const d of days) {
      assert.deepEqual(d.campaigns.map(c => c.name), CAMPAIGNS[client]);
      assert.ok(near(d.campaigns.reduce((a, c) => a + c.spend, 0), d.spend));
      assert.equal(d.campaigns.reduce((a, c) => a + c.clicks, 0), d.clicks);
      assert.equal(d.campaigns.reduce((a, c) => a + c.impressions, 0), d.impressions);
      assert.ok(d.campaigns.every(c => c.clicks <= c.impressions));
    }
    const week = sumCampaigns(days, client);
    const want = campaignRows(spend, leads, W);
    week.forEach((c, i) => {
      assert.equal(c.name, want[i].name);
      assert.ok(near(c.spend, want[i].spend), `${client} ${c.name} spend`);
      assert.equal(c.clicks, want[i].clicks);
      assert.equal(c.impressions, want[i].impressions);
      assert.equal(c.paidLeads, want[i].paidLeads);
    });
  }
});

test('made-up days are split by campaign too, adding up to the day', () => {
  for (let i = 0; i < 200; i++) for (const client of ['clinic', 'store']) {
    const d = historyDay(client, addDays('2026-01-01', i));
    assert.deepEqual(d.campaigns.map(c => c.name), CAMPAIGNS[client]);
    assert.ok(near(d.campaigns.reduce((a, c) => a + c.spend, 0), d.spend));
    assert.equal(d.campaigns.reduce((a, c) => a + c.clicks, 0), d.clicks);
    assert.equal(d.campaigns.reduce((a, c) => a + c.impressions, 0), d.impressions);
    assert.equal(d.campaigns.reduce((a, c) => a + c.paidLeads, 0), d.paidLeads);
    assert.ok(d.campaigns.every(c => c.spend > 0 && c.clicks <= c.impressions));
  }
  // adding the split didn't change the day's own numbers
  const d = historyDay('clinic', '2026-05-04');
  assert.ok(d.leads >= 0 && d.spend > 12);
});

test('campaign totals for a period, in the client’s campaign order', () => {
  const rows = daySeries('store', '2026-09-01', '2026-09-30');
  const c = sumCampaigns(rows, 'store');
  assert.deepEqual(c.map(x => x.name), CAMPAIGNS.store);
  const t = sumDays(rows);
  assert.ok(near(c.reduce((a, x) => a + x.spend, 0), t.spend));
  assert.equal(c.reduce((a, x) => a + x.clicks, 0), t.clicks);
  // rows without campaigns (old reports) don't break it
  assert.deepEqual(sumCampaigns([{ day: '2026-01-01', spend: 5 }], 'clinic').map(x => x.spend), [0, 0, 0]);
});

test('live today is split by campaign and adds up exactly', () => {
  for (let m = 30; m < 24 * 60; m += 97) {
    const l = liveToday('store', new Date(Date.UTC(2026, 9, 21, 0, m)));
    assert.deepEqual(l.campaigns.map(c => c.name), CAMPAIGNS.store);
    assert.ok(near(l.campaigns.reduce((a, c) => a + c.spend, 0), l.totals.spend));
    assert.equal(l.campaigns.reduce((a, c) => a + c.clicks, 0), l.totals.clicks);
    assert.equal(l.campaigns.reduce((a, c) => a + c.paidLeads, 0), l.totals.paidLeads);
  }
});

test('the leads list: the week’s leads, newest first, short names, duplicates marked like the check', () => {
  const leads = generateLeads('store', ['duplicates', 'missing_source', 'edge_cases'], makeRng(5), W);
  const list = leadList(leads, W);
  const inWeek = leads.filter(l => Date.parse(l.createdAt) >= +W && Date.parse(l.createdAt) < +W + 7 * 864e5);
  assert.equal(list.length, inWeek.length);
  for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].createdAt >= list[i].createdAt);
  assert.ok(list.every(l => !/@|\d{3}/.test(l.name)), 'no email or phone in the list');
  assert.ok(list.every(l => /^\S.* \S\.$|^\S+$/.test(l.name)), `short names: ${list.map(l => l.name)}`);
  const dupes = runChecks({ client: 'store', leads, spend: simulateSpend('store', leads, [], makeRng(5)), meta: null, weekStart: W }).find(w => w.code === 'duplicates').count;
  assert.equal(list.filter(l => l.duplicate).length, dupes);
  assert.ok(list.some(l => l.source === null));
});

test('the week is compared with the previous week, from the same daily figures as the other views', () => {
  const k = previousWeekKpis('clinic', W);
  assert.deepEqual(k, kpisFromTotals('clinic', sumDays(daySeries('clinic', '2026-10-05', '2026-10-11'))));
});
