import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeKpis } from '../lib/kpis.js';

const W = new Date('2026-10-12T00:00:00Z');
const T = '2026-10-13T10:00:00.000Z';
const lead = (o) => ({ id: Math.random().toString(36), firstName: 'A', lastName: 'B', email: 'a@b.c', phone: '70000000', source: 'Ads', createdAt: T, outcome: 'open', value: 0, flags: [], ...o });
const spend = (n) => ({ campaigns: [{ name: 'Ads', spend: n, paidLeads: 0 }], reportedTotal: n, simulated: true });

test('zero leads gives nulls, never NaN or Infinity', () => {
  const k = computeKpis('clinic', [], spend(90), W);
  assert.equal(k.leads, 0);
  assert.equal(k.costPerLead, null);
  assert.equal(k.costPerBooking, null);
  assert.equal(k.bookingRate, null);
  const s = computeKpis('store', [], spend(0), W);
  assert.equal(s.roas, null);
  assert.equal(s.avgOrderValue, null);
  for (const v of Object.values({ ...k, ...s })) assert.ok(v === null || Number.isFinite(v));
});

test('organic leads count as leads but not paid leads', () => {
  const k = computeKpis('clinic', [lead(), lead(), lead({ source: 'organic' }), lead({ source: 'organic' })], spend(60), W);
  assert.equal(k.leads, 4);
  assert.equal(k.paidLeads, 2);
  assert.equal(k.costPerLead, 30);
});

test('clinic bookings, cost per booking and booking rate', () => {
  const k = computeKpis('clinic', [lead({ outcome: 'converted', value: 150 }), lead(), lead(), lead()], spend(100), W);
  assert.equal(k.bookings, 1);
  assert.equal(k.costPerBooking, 100);
  assert.equal(k.bookingRate, 0.25);
});

test('cancelled orders are excluded from revenue and counted', () => {
  const k = computeKpis('store', [lead({ outcome: 'converted', value: 100 }), lead({ outcome: 'cancelled', value: 50 })], spend(50), W);
  assert.equal(k.orders, 1);
  assert.equal(k.revenue, 100);
  assert.equal(k.cancelled, 1);
  assert.equal(k.roas, 2);
  assert.equal(k.costPerOrder, 50);
  assert.equal(k.avgOrderValue, 100);
});

test('lead exactly at week end is excluded', () => {
  const k = computeKpis('clinic', [lead(), lead({ createdAt: '2026-10-19T00:00:00.000Z' })], spend(10), W);
  assert.equal(k.leads, 1);
});

test('money rounded to cents', () => {
  const k = computeKpis('clinic', [lead(), lead(), lead()], spend(100), W);
  assert.equal(k.costPerLead, 33.33);
});

test('impressions, clicks and cost per click come from the campaigns', () => {
  const sp = { campaigns: [{ name: 'Ads', spend: 100, paidLeads: 0, impressions: 5000, clicks: 90 }, { name: 'B', spend: 20, paidLeads: 0, impressions: 1000, clicks: 30 }], reportedTotal: 120, simulated: true };
  for (const client of ['clinic', 'store']) {
    const k = computeKpis(client, [lead()], sp, W);
    assert.equal(k.impressions, 6000);
    assert.equal(k.clicks, 120);
    assert.equal(k.costPerClick, 1);
  }
  const odd = computeKpis('store', [], { campaigns: [{ name: 'A', spend: 10, paidLeads: 0, impressions: 300, clicks: 7 }], reportedTotal: 10 }, W);
  assert.equal(odd.costPerClick, Math.round(10 / 7 * 100) / 100);
});

test('no clicks gives a null cost per click', () => {
  const k = computeKpis('clinic', [], { campaigns: [{ name: 'A', spend: 10, paidLeads: 0, impressions: 0, clicks: 0 }], reportedTotal: 10 }, W);
  assert.equal(k.costPerClick, null);
  assert.equal(computeKpis('clinic', [], spend(10), W).costPerClick, null);
});
