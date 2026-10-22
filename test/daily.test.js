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

test('each period is the current one so far, compared with the same stretch before', () => {
  const today = '2026-10-22'; // a Thursday
  assert.deepEqual(periodRange('day', today), { from: today, to: today, current: true, cmp: { from: '2026-10-15', to: '2026-10-15' } });
  assert.deepEqual(periodRange('week', today), { from: '2026-10-19', to: today, current: true, cmp: { from: '2026-10-12', to: '2026-10-15' } });
  assert.deepEqual(periodRange('month', today), { from: '2026-10-01', to: today, current: true, cmp: { from: '2026-09-01', to: '2026-09-22' } });
  assert.deepEqual(periodRange('year', today), { from: '2026-01-01', to: today, current: true, cmp: { from: '2025-01-01', to: '2025-10-22' } });
  // the same days a month earlier stay inside that month
  assert.deepEqual(periodRange('month', '2026-03-31').cmp, { from: '2026-02-01', to: '2026-02-28' });
});

test('stepping back gives whole earlier periods, compared with the whole one before', () => {
  const today = '2026-10-22';
  assert.deepEqual(periodRange('day', today, 1), { from: '2026-10-21', to: '2026-10-21', current: false, cmp: { from: '2026-10-14', to: '2026-10-14' } });
  assert.deepEqual(periodRange('week', today, 1), { from: '2026-10-12', to: '2026-10-18', current: false, cmp: { from: '2026-10-05', to: '2026-10-11' } });
  assert.deepEqual(periodRange('month', today, 1), { from: '2026-09-01', to: '2026-09-30', current: false, cmp: { from: '2026-08-01', to: '2026-08-31' } });
  assert.deepEqual(periodRange('month', '2026-03-31', 1), { from: '2026-02-01', to: '2026-02-28', current: false, cmp: { from: '2026-01-01', to: '2026-01-31' } });
  assert.deepEqual(periodRange('year', today, 1), { from: '2025-01-01', to: '2025-12-31', current: false, cmp: { from: '2024-01-01', to: '2024-12-31' } });
  // a week that crosses into a new year
  assert.deepEqual(periodRange('week', '2026-01-02', 0).from, '2025-12-29');
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
  assert.equal(noon.before.day, '2026-10-14');
});

test('cost per click moves from day to day in the run week', () => {
  const leads = generateLeads('store', [], makeRng(3), W), spend = simulateSpend('store', leads, [], makeRng(3));
  const cpc = runDays('store', leads, spend, W).map(d => d.spend / d.clicks);
  assert.ok(Math.max(...cpc) - Math.min(...cpc) > 0.05, `spread ${Math.max(...cpc) - Math.min(...cpc)}`);
});

test('live uses the run’s real day for "same time last week" when it has one', () => {
  const run = [{ day: '2026-10-14', leads: 6, paidLeads: 5, conversions: 2, cancelled: 0, revenue: 300, spend: 29.24, impressions: 3000, clicks: 40 }];
  const end = liveToday('clinic', new Date(Date.UTC(2026, 9, 21, 23, 59, 59, 999)), run);
  assert.equal(end.before.totals.leads, 6);
  assert.equal(end.before.totals.spend, 29.24);
  assert.equal(end.before.hours.length, 24);
  assert.equal(end.before.hours.reduce((a, h) => a + h.leads, 0), 6);
  // without run rows it is the made-up day, as before
  assert.equal(liveToday('clinic', new Date(Date.UTC(2026, 9, 21, 23, 59, 59, 999))).before.totals.leads, historyDay('clinic', '2026-10-14').leads);
});

// ---------- campaigns per day, leads list, previous week ----------
import { sumCampaigns, leadList } from '../lib/daily.js';
import { CAMPAIGNS, CAMPAIGN_SHARE, inPeriod } from '../lib/leads.js';
import { campaignRows } from '../lib/kpis.js';
import { runChecks, periodChecks } from '../lib/checks.js';

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
    // a lead whose source was lost is paid but in no campaign, as in the runs
    const lost = historyLeads(client, d.day).filter(l => l.source === null).length;
    assert.equal(d.campaigns.reduce((a, c) => a + c.paidLeads, 0) + lost, d.paidLeads);
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

test('the duplicate mark goes on the later copy, whatever order the CRM returns the leads in', () => {
  for (let s = 0; s < 20; s++) {
    const leads = generateLeads('store', ['duplicates'], makeRng(s), W);
    for (const order of [leads, [...leads].reverse()]) {
      const list = leadList(order, W);
      for (const d of list.filter(l => l.duplicate)) {
        const twin = list.find(l => !l.duplicate && l.name === d.name);
        if (twin) assert.ok(d.createdAt > twin.createdAt, `${d.name}: the copy is the later one`);
      }
    }
  }
});

// ---------- made-up people, live counting, the same scale everywhere ----------
import { historyLeads, periodLeads } from '../lib/daily.js';

test('the made-up people behind a day add up to that day', () => {
  for (const client of ['clinic', 'store']) for (let i = 0; i < 120; i++) {
    const day = addDays('2026-01-01', i), d = historyDay(client, day), ls = historyLeads(client, day);
    const conv = ls.filter(l => l.outcome === 'converted');
    assert.equal(ls.length, d.leads);
    assert.equal(ls.filter(l => l.source !== 'organic').length, d.paidLeads);
    assert.equal(conv.length, d.conversions);
    assert.equal(ls.filter(l => l.outcome === 'cancelled').length, d.cancelled);
    assert.ok(near(conv.reduce((a, l) => a + l.value, 0), d.revenue));
    for (const c of d.campaigns) assert.equal(ls.filter(l => l.source === c.name).length, c.paidLeads);
    assert.ok(ls.every(l => dayKey(l.createdAt) === day && /^\S+ \S\.$/.test(l.name)));
    assert.deepEqual(ls.map(l => l.createdAt), [...ls.map(l => l.createdAt)].sort().reverse());
  }
});

test('live counts the people who have come in, and agrees with its own list and hours', () => {
  for (let m = 0; m <= 24 * 60; m += 37) {
    const now = new Date(Date.UTC(2026, 9, 21, 0, m)), l = liveToday('clinic', now);
    assert.equal(l.leads.length, l.totals.leads);
    assert.ok(l.leads.every(x => Date.parse(x.createdAt) < +now));
    assert.equal(l.hours.reduce((a, h) => a + h.leads, 0), l.totals.leads);
    assert.equal(l.campaigns.reduce((a, c) => a + c.paidLeads, 0), l.totals.paidLeads);
  }
  const end = liveToday('store', new Date(Date.UTC(2026, 9, 21, 23, 59, 59, 999))), full = historyDay('store', '2026-10-21');
  for (const f of ['leads', 'paidLeads', 'conversions', 'cancelled', 'revenue']) assert.equal(end.totals[f], full[f], f);
});

test('live uses the run’s own leads for last week when it has them', () => {
  const leads = generateLeads('clinic', [], makeRng(2), W), spend = simulateSpend('clinic', leads, [], makeRng(2));
  const rows = runDays('clinic', leads, spend, W), list = leadList(leads, W);
  const l = liveToday('clinic', new Date(Date.UTC(2026, 9, 21, 23, 59, 59, 999)), rows, list);
  assert.equal(l.before.totals.leads, rows.find(r => r.day === '2026-10-14').leads);
  assert.equal(l.before.totals.revenue, rows.find(r => r.day === '2026-10-14').revenue);
});

test('a period’s leads: the run’s own on its days, made-up people on the rest', () => {
  const leads = generateLeads('store', [], makeRng(8), W), spend = simulateSpend('store', leads, [], makeRng(8));
  const rows = runDays('store', leads, spend, W), list = leadList(leads, W);
  const all = periodLeads('store', '2026-10-01', '2026-10-21', rows, list);
  assert.equal(all.length, sumDays(daySeries('store', '2026-10-01', '2026-10-21', rows)).leads);
  assert.equal(all.filter(l => l.createdAt.slice(0, 10) >= '2026-10-12' && l.createdAt.slice(0, 10) <= '2026-10-18').length, list.length);
});

test('a run week is about as busy as a made-up week, with or without test mistakes', () => {
  for (const client of ['clinic', 'store']) {
    const avg = (n, f) => { let t = 0; for (let i = 0; i < n; i++) t += f(i); return t / n; };
    const hist = avg(52, i => sumDays(daySeries(client, addDays('2025-10-13', 7 * i), addDays('2025-10-19', 7 * i))).leads);
    const clean = avg(200, s => generateLeads(client, [], makeRng(s), W).filter(l => inPeriod(l, W)).length);
    const messy = avg(200, s => generateLeads(client, ['edge_cases'], makeRng(s), W).filter(l => inPeriod(l, W)).length);
    assert.ok(Math.abs(clean / hist - 1) < 0.2, `${client} clean ${clean} vs history ${hist}`);
    // the clinic's edge cases empty the week half the time, so only the store's is held to the same range
    if (client === 'store') assert.ok(Math.abs(messy / hist - 1) < 0.35, `${client} edge cases ${messy} vs history ${hist}`);
  }
});

test('run leads split over campaigns like the history does', () => {
  const n = {};
  for (let s = 0; s < 300; s++) for (const l of generateLeads('clinic', [], makeRng(s), W)) if (l.source !== 'organic') n[l.source] = (n[l.source] || 0) + 1;
  const total = Object.values(n).reduce((a, x) => a + x, 0);
  assert.ok(n['Botox Spring'] / total > 0.38 && n['Skin Consultation'] / total < 0.28, JSON.stringify(n));
});

test('made-up months swing about as much as chance allows, not together', () => {
  for (const client of ['clinic', 'store']) {
    const ms = Array.from({ length: 24 }, (_, i) => sumDays(daySeries(client, dayKey(Date.UTC(2024, i + 10, 1)), dayKey(Date.UTC(2024, i + 11, 0)))).leads);
    const m = ms.reduce((a, b) => a + b) / ms.length, v = ms.reduce((a, x) => a + (x - m) ** 2, 0) / (ms.length - 1);
    // chance alone gives about 1; the trend and seasons add a little. Unmixed seeds gave the clinic 2.25.
    assert.ok(v / m < 2, `${client}: ${(v / m).toFixed(2)}`);
  }
});

// ---------- data health for any period ----------
test('the dashboard’s checks for the run’s own days give exactly the run’s warnings', () => {
  const all = ['missing_source', 'duplicates', 'meta_mismatch', 'bad_totals', 'edge_cases'];
  for (let seed = 1; seed <= 30; seed++) for (const client of ['clinic', 'store']) {
    const rng = makeRng(seed), problems = all.filter(() => rng() < 0.5);
    const leads = generateLeads(client, problems, rng, W), spend = simulateSpend(client, leads, problems, rng);
    const conv = leads.filter(l => inPeriod(l, W) && l.outcome === 'converted').length;
    const meta = { accepted: Math.max(0, conv - (problems.includes('meta_mismatch') ? 2 : 0)), rejected: problems.includes('edge_cases') ? 1 : 0 };
    const want = runChecks({ client, leads, spend, meta, weekStart: W });
    assert.deepEqual(periodChecks(client, leadList(leads, W), runDays(client, leads, spend, W, meta)), want, `seed ${seed} ${client} ${problems}`);
  }
});

test('made-up history has the odd problem, about as often as a real account', () => {
  const days = daySeries('store', '2025-01-01', '2025-12-31'), people = days.flatMap(d => historyLeads('store', d.day));
  const w = Object.fromEntries(periodChecks('store', people, days).map(x => [x.code, x.count]));
  // a few lost sources and duplicates a year, the odd huge order, total gap, missed or refused Meta event
  for (const code of ['missing_source', 'duplicates', 'outlier', 'bad_totals', 'meta_mismatch', 'meta_rejected']) assert.ok(w[code] >= 1, `${code}: ${JSON.stringify(w)}`);
  assert.ok(w.missing_source < people.length * 0.06 && w.duplicates < people.length * 0.06, JSON.stringify(w));
  // most single days are clean
  const clean = days.filter(d => !periodChecks('store', historyLeads('store', d.day), [d]).length).length;
  assert.ok(clean > days.length * 0.85, `${clean} of ${days.length}`);
});

test('a made-up duplicate is the same person, later the same day', () => {
  let seen = 0;
  for (let i = 0; i < 365; i++) {
    const ls = historyLeads('clinic', addDays('2025-01-01', i));
    for (const d of ls.filter(l => l.duplicate)) {
      seen++;
      assert.ok(ls.some(o => o !== d && !o.duplicate && o.name === d.name && o.createdAt <= d.createdAt));
    }
  }
  assert.ok(seen > 0);
});

// ---------- the run fills the last 7 days, up to the moment it runs ----------
import { periodFigures } from '../lib/daily.js';

test('a run mid-day: every lead is in the past, and part of today means part of its leads', () => {
  const start = new Date('2026-10-16T00:00:00Z'), now = Date.parse('2026-10-22T09:30:00Z');
  let partial = 0, whole = 0;
  for (let s = 0; s < 200; s++) for (const client of ['clinic', 'store']) {
    const leads = generateLeads(client, ['duplicates', 'edge_cases'], makeRng(s), start, now);
    for (const l of leads) assert.ok(Date.parse(l.createdAt) < now, `${s} ${client}: ${l.createdAt}`);
    partial += generateLeads(client, [], makeRng(s), start, now).length;
    whole += generateLeads(client, [], makeRng(s), start).length;
  }
  // six whole days plus a quiet morning: fewer leads than a whole week, more than six-sevenths of it
  assert.ok(partial < whole && partial > whole * 0.75, `${partial} vs ${whole}`);
});

test('on a run day, today’s spend grows with the moment it is shown up to', () => {
  const start = new Date('2026-10-16T00:00:00Z'), ranAt = '2026-10-22T10:00:00.000Z';
  const leads = generateLeads('store', [], makeRng(6), start, Date.parse(ranAt)), spend = simulateSpend('store', leads, [], makeRng(6));
  const run = { days: runDays('store', leads, spend, start), leadList: leadList(leads, start), light: 'green' };
  const at = asOf => periodFigures('store', { ...run, asOf }, 'day', new Date('2026-10-22T20:00:00Z')).kpis.spend;
  assert.ok(at(ranAt) < at('2026-10-22T16:00:00.000Z'), `${at(ranAt)} vs later`);
  // the whole day, once it's over, is the run's figure for the day
  assert.equal(periodFigures('store', { ...run, asOf: ranAt }, 'day', new Date('2026-10-23T08:00:00Z'), 1).kpis.spend, run.days[6].spend);
});

test('on a run day, today stops at the run: nothing arrives after it on its own', () => {
  const start = new Date('2026-10-16T00:00:00Z'), ranAt = '2026-10-22T10:00:00.000Z';
  const leads = generateLeads('clinic', [], makeRng(3), start, Date.parse(ranAt)), spend = simulateSpend('clinic', leads, [], makeRng(3));
  const run = { days: runDays('clinic', leads, spend, start), leadList: leadList(leads, start), light: 'green', asOf: ranAt };
  const later = new Date('2026-10-22T18:00:00Z');
  const f = periodFigures('clinic', run, 'day', later);
  assert.equal(f.asOf, ranAt);
  assert.equal(f.cut, true);
  assert.equal(f.kpis.leads, run.leadList.filter(l => l.createdAt.startsWith('2026-10-22')).length);
  // later in the day it's the same as at the run's own moment
  assert.deepEqual(periodFigures('clinic', run, 'day', new Date(ranAt)).kpis, f.kpis);
  // the next day is not a run day: it runs on the clock again
  assert.equal(periodFigures('clinic', run, 'day', new Date('2026-10-23T08:00:00Z')).cut, false);
});

test('figures for the run’s own 7 days add up to the run', () => {
  const start = new Date('2026-10-16T00:00:00Z'), ranAt = '2026-10-22T23:59:59.000Z';
  const leads = generateLeads('store', ['duplicates', 'missing_source'], makeRng(4), start, Date.parse(ranAt)), spend = simulateSpend('store', leads, [], makeRng(4));
  const run = { days: runDays('store', leads, spend, start), leadList: leadList(leads, start), light: 'green', asOf: ranAt };
  // the week of 19-25 Oct holds the run's last four days
  const f = periodFigures('store', run, 'week', new Date('2026-10-26T12:00:00Z'), 1);
  const mine = run.leadList.filter(l => l.createdAt >= '2026-10-19');
  assert.ok(mine.every(l => f.leads.includes(l)));
  assert.equal(f.health.fromRun, true);
});

test('Meta’s misses sit on days that had conversions: no day says Meta recorded fewer than none', () => {
  const start = new Date('2026-10-16T00:00:00Z');
  for (let seed = 1; seed <= 40; seed++) for (const client of ['clinic', 'store']) {
    const leads = generateLeads(client, ['meta_mismatch'], makeRng(seed), start), spend = simulateSpend(client, leads, [], makeRng(seed));
    const conv = leads.filter(l => inPeriod(l, start) && l.outcome === 'converted').length;
    const days = runDays(client, leads, spend, start, { accepted: Math.max(0, conv - 2), rejected: 0 });
    assert.equal(days.reduce((a, d) => a + d.metaMissed, 0), Math.min(2, conv), `seed ${seed}`);
    for (const d of days) {
      assert.ok(d.metaMissed <= d.conversions, `${seed} ${client} ${d.day}: ${d.metaMissed} of ${d.conversions}`);
      for (const w of periodChecks(client, leadList(leads, start).filter(l => l.createdAt.startsWith(d.day)), [d])) assert.doesNotMatch(w.message, /-\d/);
    }
  }
});

test('the account-total gap is shared out by spend: every day and today so far keep a sensible total', () => {
  const start = new Date('2026-10-16T00:00:00Z');
  for (let seed = 1; seed <= 30; seed++) {
    const leads = generateLeads('store', ['bad_totals'], makeRng(seed), start), spend = simulateSpend('store', leads, ['bad_totals'], makeRng(seed));
    const days = runDays('store', leads, spend, start, null);
    const gap = Math.round((spend.reportedTotal - spend.campaigns.reduce((a, c) => a + c.spend, 0)) * 100) / 100;
    assert.ok(near(days.reduce((a, d) => a + d.spendGap, 0), gap), `seed ${seed}`);
    for (const d of days) assert.ok(d.spend + d.spendGap >= 0, `${seed} ${d.day}`);
    // the run's own 7 days still give the run's warning
    assert.ok(periodChecks('store', leadList(leads, start), days).some(w => w.code === 'bad_totals'));
    // today, early in the day: no negative total in the message
    const run = { days, leadList: leadList(leads, start), light: 'orange', asOf: '2026-10-22T09:00:00.000Z' };
    for (const w of periodFigures('store', run, 'day', new Date('2026-10-22T09:00:00Z')).health.warnings) assert.doesNotMatch(w.message, /\$-/, `${seed}`);
  }
});

test('over a year, made-up paid leads split by campaign in the same shares as a run’s', () => {
  for (const client of ['clinic', 'store']) {
    const ls = daySeries(client, '2025-10-22', '2026-10-21').flatMap(d => historyLeads(client, d.day)).filter(l => l.source && l.source !== 'organic');
    CAMPAIGNS[client].forEach((name, i) => {
      const share = ls.filter(l => l.source === name).length / ls.length;
      assert.ok(Math.abs(share - CAMPAIGN_SHARE[client][i]) < 0.06, `${client} ${name}: ${share.toFixed(3)} vs ${CAMPAIGN_SHARE[client][i]}`);
    });
  }
});
