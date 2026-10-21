# Client Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the demo page's report cards with a Coupler-style client dashboard (tabs, six cards, funnel, campaign chart, AI box, data health), backed by simulated impressions and clicks.

**Architecture:** The run's simulated spend gains impressions and clicks per campaign; KPIs gain client totals and cost per click; the saved report carries each client's campaigns. The page turns a report client into a plain view model (`dashboardView`, tested in Node) and draws it with the existing `h()` builder and hand-written CSS.

**Tech Stack:** Node 20 ESM, `node --test`, n8n (templates built by `scripts/make-templates.mjs`, deployed by `scripts/deploy.mjs`), static HTML/CSS/JS on GitHub Pages.

**Spec:** `docs/superpowers/specs/2026-10-21-dashboard-design.md`

## Global Constraints

- Repos: demo `C:\Users\ibrah\VS-projects\agency-report-demo` (branch `build`); page `C:\Users\ibrah\VS-projects\ibrahim-jaafar.github.io\agency-demo\`.
- The page's `lib/` must stay identical to the demo repo's: after any `lib/` change run `npm run site` in the demo repo.
- No new dependencies, no chart library.
- Simulated numbers must agree: clicks ≤ impressions, clicks > the campaign's billed leads, costPerClick = spend ÷ clicks.
- Changes stay relative % (`pctChanges`), never "points".
- Layout: no horizontal scroll at ~360 px and ~1440 px; light theme inside the dashboard only.
- Portfolio card, `profile.md`, README wording: only words Ibrahim approves (ask before writing them).
- Git Bash: `MSYS_NO_PATHCONV=1` for API paths; use node fetch, not Git Bash curl.

## Review Focus

- An old saved report (no `campaigns`, no `impressions`/`clicks`/`costPerClick`) is what the page loads first: it must render with "—", no crash. → test in Task 3.
- Clinic empty week (zero leads, `edge_cases`): cards show "—" where dividing by zero, funnel still drawn, rates "—". → test in Task 3.
- A `partial` report where a client has `kpis` but missing `summary` fields: AI box must not crash. → test in Task 3.
- A cost KPI rising must read as bad (red), spend neutral, revenue rising good. → test in Task 3.
- `bad_totals` still fires and is still caught after `simulateSpend` draws extra random numbers. → test in Task 1.

---

### Task 1: Simulate impressions and clicks; add click KPIs

**Files:**
- Modify: `lib/spend.js`, `lib/kpis.js`
- Test: `test/spend.test.js`, `test/kpis.test.js`

**Interfaces:**
- Produces: each `spend.campaigns[i]` is `{ name, spend, paidLeads, impressions: int, clicks: int }`. `computeKpis` result gains `impressions`, `clicks` (sums over campaigns) and `costPerClick` (`ratio(spend, clicks, cents)`), for both clients.

- [ ] **Step 1: Write the failing tests** in `test/spend.test.js`:

```js
test('impressions and clicks agree with spend', () => {
  for (let i = 0; i < 50; i++) for (const client of ['clinic', 'store']) {
    const leads = generateLeads(client, ['missing_source'], makeRng(i), W);
    const s = simulateSpend(client, leads, [], makeRng(i));
    for (const c of s.campaigns) {
      assert.ok(Number.isInteger(c.impressions) && Number.isInteger(c.clicks));
      assert.ok(c.clicks < c.impressions);
      const ctr = c.clicks / c.impressions;
      assert.ok(ctr >= 0.0095 && ctr <= 0.0305, `ctr ${ctr}`);
      const cpc = c.spend / c.clicks;
      assert.ok(cpc >= 0.59 && cpc <= 1.51, `cpc ${cpc}`);
      assert.ok(c.clicks > c.paidLeads);
    }
  }
});
```
and extend the `bad_totals` test loop to also assert every campaign has `clicks > 0`.
In `test/kpis.test.js`: `costPerClick` equals `Math.round(spend / clicks * 100) / 100`, `impressions`/`clicks` equal the campaign sums, for both clients; with campaigns whose `clicks` are 0, `costPerClick` is `null`.

- [ ] **Step 2: Run** `npm test` → the new tests FAIL (`impressions` undefined).

- [ ] **Step 3: Implement.** In `simulateSpend`, after each campaign's `spend`: `clicks = Math.round(spend / cpc)` with `cpc` uniform in $0.60–$1.50, then `impressions = Math.round(clicks / ctr)` with `ctr` uniform in 1%–3%. (Spend ≥ $15 per billed lead and cpc ≤ $1.50 guarantees ≥ 10 clicks per billed lead.) In `computeKpis`, add the three fields to `base`.

- [ ] **Step 4: Run** `npm test` → all PASS (existing tests included; AI input is unaffected because `pickKpis` filters by `KPI_KEYS`, confirm `test/ai.test.js` passes unchanged).

- [ ] **Step 5: Commit** `feat: simulated impressions and clicks, cost per click`.

### Task 2: Carry campaigns into the saved report; deploy

**Files:**
- Modify: `lib/report.js`, `scripts/make-templates.mjs` (the "Checks" node that builds `clients`, near line 377–380), then regenerate `workflows/` via the script.
- Test: `test/report.test.js`, `test/build.test.js` if it checks node code.

**Interfaces:**
- Consumes: Task 1 campaign shape.
- Produces: each `report.clients[i]` gains `campaigns: [{ name, spend, paidLeads, impressions, clicks }]` (or `null` when not given).

- [ ] **Step 1: Failing test** in `test/report.test.js`: `buildReport` with a client carrying `campaigns` returns them unchanged on that client; a client without `campaigns` gets `campaigns: null`.
- [ ] **Step 2: Run** `npm test` → FAIL.
- [ ] **Step 3: Implement.** `buildReport` maps `campaigns: c.campaigns ?? null`. In the weekly-report template, the per-client object returned next to `computeKpis` adds `campaigns: c.spend.campaigns`. Run `node scripts/make-templates.mjs`.
- [ ] **Step 4: Run** `npm test` → PASS. Then `npm run site`.
- [ ] **Step 5: Deploy and check live.** `node scripts/deploy.mjs`, then one run with `.probe/try.mjs` (clean scenario). Expected: the saved report's clients each have 3 campaigns with impressions/clicks, and `kpis.costPerClick` is set.
- [ ] **Step 6: Commit** (demo repo) `feat: report carries per-campaign numbers`. Commit the copied `lib/` in the portfolio repo (not pushed yet).

### Task 3: Dashboard view model (pure, tested)

**Files:**
- Modify: `agency-demo/app.js` (portfolio repo)
- Test: `agency-demo/app.test.mjs`

**Interfaces:**
- Consumes: report client `{ client, name, kpis, changes, campaigns, warnings, light, summary }`.
- Produces: `export function dashboardView(c)` returning
  `{ cards: [{ key, label, value, change, tone, simulated }], extras: [{ label, value }], funnel: [{ label, value, rate }], campaigns: [{ name, spend, leads, spendPct, leadsPct }], ai: { headline, summary, nextSteps }, light, warnings }`.
  `value`/`rate` are display strings (via `fmt`); `change` is `"▲ 12%"`, `"▼ 4%"`, `"0%"` or `null`; `tone` is `'good' | 'bad' | 'neutral'`.

Pinned values:
- Cards, clinic: `spend` Ad spend, `costPerClick` Cost per click, `leads` Leads, `costPerLead` Cost per paid lead, `bookings` Booked consultations, `bookingRate` Lead-to-booking rate. Store: `spend` Ad spend, `costPerClick` Cost per click, `leads` Leads, `costPerOrder` Cost per order, `revenue` Revenue, `roas` Return on ad spend.
- `simulated: true` on `spend` and `costPerClick`.
- Tone: sense +1 (leads, bookings, bookingRate, revenue, roas, orders, avgOrderValue): up good, down bad; sense −1 (costPerClick, costPerLead, costPerBooking, costPerOrder, cancelled): up bad, down good; spend: neutral; change 0 or null: neutral.
- Extras (everything not on a card, so nothing disappears): clinic `paidLeads` Paid leads, `costPerBooking` Cost per booking, `cancelled` Cancelled; store `orders` Orders, `avgOrderValue` Average order, `paidLeads` Paid leads, `cancelled` Refunded.
- Funnel: Impressions → Clicks → Leads → Booked consultations / Orders; `rate` on each step after the first = this ÷ previous as `pct`, "—" when either is missing or previous is 0.
- Campaign `spendPct`/`leadsPct` = share of the largest campaign's spend/paidLeads (0–100, 0 when the max is 0). `campaigns: []` when the report has none.

- [ ] **Step 1: Failing tests** in `app.test.mjs`:
  - `dashboardView` card labels and keys for clinic and store match the pinned lists, in order.
  - Tone: `costPerClick` change +10 → `bad`; `costPerLead` −5 → `good`; `revenue` +20 → `good`; `spend` +50 → `neutral`.
  - Old report (no `campaigns`, kpis without impressions/clicks/costPerClick): no throw; funnel first two values "—"; `campaigns` is `[]`; costPerClick card value "—".
  - Empty week (`leads: 0`, `bookings: 0`, ratios null): funnel has 4 steps; Leads→Booked rate "—".
  - Missing `summary`: `ai` is `{ headline: '', summary: '', nextSteps: [] }`.
  - Extras for store include `Orders` and `Refunded`.
- [ ] **Step 2: Run** `node --test agency-demo/app.test.mjs` (portfolio repo root) → FAIL.
- [ ] **Step 3: Implement** `dashboardView` in `app.js` beside `stepView`; reuse `fmt` and the existing `KPI_TEXT` sense values where they match (extend `KPI_TEXT` or replace it, but keep one source of labels).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: dashboard view model`.

### Task 4: Draw the dashboard and replace the report cards

**Files:**
- Modify: `agency-demo/app.js` (`render()`), `agency-demo/index.html` (CSS)

**Interfaces:**
- Consumes: `dashboardView` (Task 3).

- [ ] **Step 1: Implement.** In `render()`, keep the head panel (week heading, overview, template/partial notes) and the "Did the checks catch the mistakes?" panel first; replace the `.clients` cards with one `.dash` panel: header (title + one tab button per client, `aria-selected`, first selected), then for the selected client: six cards (value, change coloured by `tone`, small "simulated" tag), extras line, funnel (bars narrowing, rate between steps), campaign bars (spend and leads per campaign), AI box (headline, summary, next steps), data health (light + warnings, each still tagged with the visitor's mistake via `WARNING_FROM`/`PROBLEM_TEXT`). Clicking a tab redraws only the dashboard body. Slack panel stays after. Mockup for reference: `.superpowers/brainstorm/65038-1792585560/content/layout.html` option A (demo repo).
- [ ] **Step 2: CSS** in `index.html`: light surface for `.dash` only; cards `grid-template-columns: repeat(auto-fit, minmax(150px, 1fr))` (2 per row at 360 px); funnel and campaign chart side by side ≥ 760 px, stacked below; good = green, bad = red, neutral = grey.
- [ ] **Step 3: Browser check** with a local server and Chrome DevTools (the live API only allows the real origin; to test locally either load the latest report through `DEMO_EXTRA_ORIGIN` as in Task 13 of the old plan, or render a saved report JSON from the console): both tabs, an old report, an empty clinic week; 360 px and 1440 px have no horizontal scroll; no console errors.
- [ ] **Step 4: Run** `node --test agency-demo/app.test.mjs` → PASS.
- [ ] **Step 5: Commit** `feat: client dashboard replaces report cards`.

### Task 5: Publish and verify live

- [ ] **Step 1:** Push the portfolio repo; wait for Pages (~1 min).
- [ ] **Step 2:** On https://ibrahim-jaafar.github.io/agency-demo/: latest report loads as the dashboard; one Random run → caught panel, dashboard (both tabs), Slack panel; funnel and campaign numbers agree with the cards; 360 px and 1440 px no horizontal scroll; no console errors.
- [ ] **Step 3:** Draft wording for the portfolio card, `profile.md` and the demo README mentioning the dashboard; show it to Ibrahim; write only what he approves; commit and push.
- [ ] **Step 4:** Append a dated entry to `.superpowers/sdd/2026-10-18-agency-report-demo/progress.md`; update the tracker.
