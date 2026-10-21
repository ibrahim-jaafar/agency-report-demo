# Agency demo: client dashboard (design)

Date: 2026-10-21. Status: draft for Ibrahim's approval.

## Why

The agency demo (live at ibrahim-jaafar.github.io/agency-demo/) ends with a report: plain cards with a table of
numbers per client. Ibrahim wants that report to look like a real marketing dashboard, modelled on Coupler.io's
"Google Ads leads dashboard": coloured number cards with their change, a funnel, charts.

Who looks at it: recruiters and agency owners visiting the portfolio, mostly non-technical. In Ibrahim's words, they
should see "a nice tidy and simple UI that non technical people can understand with all necessary data present on
the main page".

## Goals

- A tidy, simple dashboard that a non-technical visitor understands at a glance.
- Every important number for a client is visible without clicking into anything (switching client tabs is fine).
- The full ad funnel: impressions → clicks → leads → bookings (clinic) or orders (store).
- Keep what proves the automation works: whether the checks caught the visitor's mistakes, the data warnings, the
  AI summary, the Slack alert.

## Non-goals

- No history or trend charts across runs: each run is a fresh random week, so a chart across runs would be noise.
- No daily spend or daily "spend vs value" line chart: spend only exists per campaign per week.
- No filters (date range, account, campaign type) like the example's top row.
- No change to how the run works, the checks, the AI prompt or the Slack alert text.

## Anti-goals (would be a failure even if it works)

- Clutter: a page that looks like a busy analytics tool instead of something a client reads in ten seconds.
- Simulated numbers that pass as real ad data, or that are impossible (more clicks than impressions, more leads
  than clicks, a cost per click that doesn't match spend ÷ clicks).
- Losing the "did the checks catch it?" story: that is the point of the demo.

## Decisions made with Ibrahim

1. **Layout A, one client at a time.** A header with the title and tabs: *Lumière Skin Clinic* | *Northwind Home*.
   The tab shows one client's dashboard:
   - **Six coloured number cards**, each with its value and its change since the previous report (▲/▼ %).
   - **Funnel:** impressions → clicks → leads → bookings/orders, with the step-to-step rates.
   - **Campaign chart:** the client's 3 campaigns, showing spend and leads per campaign.
   - **AI box** ("What happened this week"): the AI's headline, summary and next steps.
   - **Data health:** the client's green/orange/red light with its warnings, each still marked with the mistake the
     visitor chose that caused it (as today).
   A mockup of this layout was shown and chosen (see `.superpowers/brainstorm/`, `layout.html`, option A).
2. **Simulate impressions and clicks** so the full funnel can be shown, alongside the spend that is already
   simulated.
3. **It replaces the report section** ("3. The report") of the demo page. Around it:
   - Above: the week heading, the overview line, the "template used" and "partial report" notes, and
     "Did the checks catch the mistakes?". These answer the visitor's test, so they come first.
   - Below: the Slack alert panel, unchanged. "Under the hood" stays after it, unchanged.

## Claude's calls (not discussed with Ibrahim; he can overrule while reading)

- **The six cards.** Clinic: Ad spend, Cost per click, Leads, Cost per paid lead, Booked consultations,
  Lead-to-booking rate. Store: Ad spend, Cost per click, Leads, Cost per order, Revenue, Return on ad spend.
  Numbers that lose their card (impressions, clicks, cost per booking, average order, cancelled/refunded, paid
  leads) still appear on the page: in the funnel, or as a small line of secondary figures under the cards. None of
  today's numbers disappear.
- **Change arrows say good or bad.** Colour follows the meaning, not the direction: cost per click/lead/order going
  down is good (green), going up is bad (red); spend is neutral. The current page already has this "sense" per KPI.
- **Simulated means labelled.** Impressions, clicks and spend carry a small "simulated" mark (spend already says
  "(simulated)" in the workflow steps). Everything else is real output of the run.
- **Realistic simulation.** Impressions and clicks are made per campaign from that campaign's spend, so all numbers
  agree with each other: clicks = impressions × a click-through rate in a believable range (roughly 1–3%), cost per
  click = spend ÷ clicks, and clicks are always more than that campaign's paid leads. Same seeded random numbers as
  the rest of the run, so a run is reproducible. Exact ranges are the builder's call within these rules.
- **The `bad_totals` mistake keeps working.** It currently makes the account total differ from the sum of
  campaigns; impressions/clicks don't need their own broken version.
- **Light theme, like the example,** inside the dashboard area only; the rest of the demo page keeps its current
  look. The dashboard must work at phone width (~360 px: cards wrap to 2 per row, funnel and chart stack) with no
  horizontal scroll, like the current page.
- **Charts without a library:** plain HTML/CSS (or inline SVG) bars and funnel. The page has no chart library today
  and the charts are simple.
- **Empty week (edge case):** a client with zero leads shows "—" in cards whose maths has nothing to divide by (the
  page's `fmt` already does this), and the funnel still renders.

## Data: what exists, what to add

Exists today in the saved report (`lib/report.js`), per client: `kpis`, `previousKpis`, `changes` (% per KPI),
`warnings`, `light`, AI `summary` (headline, summary, next_steps). KPIs come from `lib/kpis.js`.

Needs adding:
- **Per-campaign numbers in the report**: name, spend, paid leads, impressions, clicks. Today the spend per campaign
  exists inside the run (`simulateSpend` in `lib/spend.js`, called in the demo-run workflow) but is not copied into
  the saved report.
- **Impressions and clicks** per campaign, and their client totals, plus **cost per click** as a KPI (so it gets a
  change % like the others). Cost per click uses the same spend as the spend card (the sum of the campaigns), and changes stay relative % like today (no "points"). Older reports saved before this change have no impressions/clicks: the page must still
  render them (funnel top shows "—", no crash), because the page loads the latest saved report on open.

## Where things live (for the builder)

- Demo repo `VS-projects/agency-report-demo` (branch `build`): `lib/` (shared logic, tested with `node --test`),
  `scripts/make-templates.mjs` → `scripts/deploy.mjs` (builds and deploys the n8n workflows; see
  `.superpowers/sdd/2026-10-18-agency-report-demo/progress.md` and the README).
- Page: `VS-projects/ibrahim-jaafar.github.io/agency-demo/` (`index.html`, `app.js`, `app.test.mjs`, and a copy of
  `lib/` that must stay identical to the demo repo's). Publishing = commit + push of the portfolio repo.
- Today's report rendering: `render()` in `agency-demo/app.js`.

## Left to the builder

- Exact colours, spacing, fonts and chart drawing, within "tidy, simple, like the example, light theme".
- Exact simulation ranges, within the realism rules above.
- How the secondary figures are shown, as long as none of today's numbers disappear.
- Test design, following the project's existing tests.

## Done means

- A live run on the real site shows the dashboard for both clients; the funnel and campaign numbers agree with the
  cards; the caught/missed panel and Slack panel still show; no console errors.
- Checked at ~360 px and ~1440 px with no horizontal scroll.
- `node --test` passes in the demo repo, the page tests pass, and the page's `lib/` matches the demo repo's.
- The portfolio card, `profile.md` and the demo README mention the dashboard only in words Ibrahim approves.
