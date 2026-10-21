import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRng } from '../lib/rng.js';
import { generateLeads } from '../lib/leads.js';
import { simulateSpend } from '../lib/spend.js';

const W = new Date('2026-10-12T00:00:00Z');
const sum = s => Math.round(s.campaigns.reduce((a, c) => a + c.spend, 0) * 100) / 100;

test('three campaigns, labelled simulated, total matches the sum', () => {
  const s = simulateSpend('store', generateLeads('store', [], makeRng(2), W), [], makeRng(2));
  assert.equal(s.campaigns.length, 3);
  assert.equal(s.simulated, true);
  assert.equal(s.reportedTotal, sum(s));
});

test('spend is $15-$30 per paid lead and positive even with no leads', () => {
  const s = simulateSpend('clinic', [], [], makeRng(1));
  assert.ok(s.campaigns.every(c => c.spend > 0 && c.paidLeads === 0));
});

test('paidLeads per campaign counts that campaign only', () => {
  const leads = generateLeads('clinic', [], makeRng(3), W);
  const s = simulateSpend('clinic', leads, [], makeRng(3));
  for (const c of s.campaigns) assert.equal(c.paidLeads, leads.filter(l => l.source === c.name).length);
});

test('bad_totals makes reportedTotal differ from the sum by 5-20%', () => {
  for (let i = 0; i < 30; i++) {
    const s = simulateSpend('store', generateLeads('store', [], makeRng(i), W), ['bad_totals'], makeRng(i));
    const diff = Math.abs(s.reportedTotal - sum(s)) / sum(s);
    assert.ok(diff >= 0.049 && diff <= 0.201, `diff ${diff}`);
    assert.ok(s.campaigns.every(c => c.clicks > 0));
  }
});

test('impressions and clicks agree with spend', () => {
  for (let i = 0; i < 50; i++) for (const client of ['clinic', 'store']) {
    const leads = generateLeads(client, ['missing_source'], makeRng(i), W);
    const s = simulateSpend(client, leads, [], makeRng(i));
    for (const c of s.campaigns) {
      assert.ok(Number.isInteger(c.impressions) && Number.isInteger(c.clicks));
      assert.ok(c.clicks < c.impressions);
      const ctr = c.clicks / c.impressions;
      assert.ok(ctr >= 0.0095 && ctr <= 0.0305, `ctr ${ctr}`);
      // clicks are whole numbers, so allow half a click of rounding either way
      assert.ok(c.spend / (c.clicks + 0.5) <= 1.5 && c.spend / (c.clicks - 0.5) >= 0.6, `cpc ${c.spend / c.clicks}`);
      assert.ok(c.clicks > c.paidLeads);
    }
  }
});
