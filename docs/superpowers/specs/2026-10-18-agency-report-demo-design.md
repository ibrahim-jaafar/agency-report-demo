# Agency Report Demo — design

Date: 2026-10-18 · Owner: Ibrahim Jaafar · Status: draft for approval

## 1. Why this exists

Ibrahim is applying for the RemotelyX **AI Development Specialist** role (marketing agency whose clients are cash-pay medical practices) and the **AI Automation & Systems Manager** role (ecommerce focus). When ChatGPT assessed his public profile against the first job, it rated him a strong technical fit but named five gaps:

1. GoHighLevel (GHL) and ad-platform integrations (Meta Pixel / Conversions API) — the biggest gap
2. n8n / Make / Zapier — his skills list says "n8n (learning)"
3. Marketing performance reporting (cost per lead, ROAS, funnel conversion)
4. Healthcare marketing and sensitive data (nice-to-have)
5. Explaining failures and handing off to non-technical people

This project closes gaps 1–5 with one real, working thing a recruiter can run themselves, instead of claims. It mirrors the exercise ChatGPT said it would give him in an interview: pull campaign and lead data for several clients, check it, have AI draft a report, handle failures safely, document the handoff.

**Success:** a recruiter clicks "Run the demo" on his portfolio site, watches the n8n workflow run live, and ends on a polished agency report. His skills list can then say n8n without "(learning)", and his profile can claim GHL + Meta Conversions API work honestly.

## 2. Goals

- An n8n workflow that, per run: adds new demo leads to GHL, pulls leads and ad spend, sends conversions to Meta as test events, runs data checks, has an AI write a plain-language summary, and returns the report.
- A public demo page that starts a run and shows it live, then the result.
- Two made-up clients that speak to both target jobs.
- A troubleshooting guide a non-technical account manager could follow.
- Everything free: no paid plans, no card.

## 3. Non-goals

- Real ad spend or real Meta ad reporting (needs real ads running; ad spend is made-up data).
- Sending real email or SMS (disabled in the GHL sandbox anyway).
- Real patient data or claimed healthcare experience.
- Giving the public access to the n8n editor.
- A video walkthrough — deferred (see §10).

## 4. Anti-goals (fails even if it technically works)

- **The UI looks unpolished or behaves buggily** (Ibrahim's words: "if the UI is not good or is very buggy"). The demo page is held to the same visual standard as the portfolio site and must handle every bad case gracefully.
- AI deciding facts: the AI must never be the one that decides whether data is right. Checks are plain code; the AI only writes the summary.
- Patient details sent to the AI.
- Anything that misrepresents what is real: the page must say clearly which data is live (GHL, Meta test events) and which is simulated (ad spend).

## 5. Decisions made by Ibrahim

- **Show:** the workflow running live and the report it produces.
- **Accounts:** free or trial only.
- **Hosting:** a server, if free → Hugging Face Space (n8n) + Supabase (n8n's database). Fallback if that proves too much work: his own PC exposed through a free Cloudflare Tunnel.
- **Not Oracle** for hosting.
- **Clients:** one medical clinic + one online store (fits the GHL sandbox limit of 2 sub-accounts).
- **Layout:** agency overview — both clients side by side with a status light; click a client for its full report (mockup option B).
- **While running:** a step strip across the top ticks off live, and client cards fill in as data arrives; the strip stays after the run as "how this was made" (mockup option 2).
- **Data:** each run adds new made-up leads to GHL, so numbers change and the run is visibly live.
- **Troubleshooting guide:** yes.
- **Video:** later, and only if it needs neither his face nor his voice.
- **AI model for the summary:** decide later.

## 6. How it works

### 6.1 Services

| Part | Service | Cost | Notes |
|---|---|---|---|
| Workflow engine | n8n Community Edition, Docker, on a Hugging Face Space (cpu-basic: 2 vCPU, 16 GB RAM) | free | Space disk is wiped on restart; Space sleeps after 48 h without visits |
| n8n database | Supabase Postgres (free plan, 500 MB) | free | Holds workflows, credentials (encrypted with `N8N_ENCRYPTION_KEY`), execution history — survives Space restarts |
| CRM | GoHighLevel Marketplace developer **sandbox** (2 sub-accounts, 6 months, renewable; demos allowed under its fair-use rules) | free (confirm at signup) | Backup: GHL 14-day trial |
| Conversions | Meta Conversions API with a `test_event_code` from Events Manager → Test Events | free | Events appear live in Events Manager, labelled as test |
| Demo page | Ibrahim's portfolio site (GitHub Pages, static) | free | Calls the n8n webhook from the browser |

Template to start from: existing public n8n Spaces (e.g. `Ziho7/n8n`), configured with Supabase via the transaction pooler.

### 6.2 The two clients (made up)

- **Lumière Skin Clinic** — medical aesthetics clinic. Funnel: ad → lead → booked consultation. KPIs: ad spend, leads, cost per lead, booked consultations, cost per booked consultation, lead-to-booking rate.
- **Northwind Home** — online home-goods store. Funnel: ad → lead/visitor → order. KPIs: ad spend, orders, revenue, ROAS, cost per order, average order value.

Names are placeholders; the builder may change them as long as they are clearly fictional.

### 6.3 One run, step by step

1. **Start:** the demo page calls the n8n webhook. n8n checks the run limits (§6.6) and returns a run ID straight away.
2. **Add demo leads:** create a handful of new made-up contacts/opportunities in each GHL sub-account, with realistic variety, including a few deliberately flawed ones (missing source, duplicate phone/email) so the checks have something to find.
3. **Pull leads:** read this period's contacts and opportunities from both sub-accounts via the GHL API.
4. **Pull ad spend:** generate/read made-up campaign spend for the period (clearly labelled simulated).
5. **Send conversions to Meta:** send booked consultations / orders to the Conversions API with the test event code. Hash personal fields as Meta requires. Record what Meta accepted.
6. **Data checks (plain code, not AI):**
   - conversions reported to Meta vs bookings/orders in GHL don't match
   - leads with no source
   - duplicate leads
   - totals that don't add up (e.g. campaign totals ≠ sum of campaigns)
7. **AI summary:** send only aggregated numbers and the list of warnings — never names, phones, emails or any patient details — and get a short plain-language summary per client plus the agency overview line. The AI may describe the warnings but may not change or overrule them.
8. **Report:** assemble the result (numbers, comparison with the previous run/period, warnings, summary) and store it with the run ID.
9. **Clean-up:** delete demo leads older than a set age so the sandbox stays small (fair use asks for low volume).

### 6.4 Demo page

- **Before a run:** short intro (what this is, which parts are live and which are simulated), the "Run the demo" button, and the most recent run's report so the page is never empty.
- **During a run:** step strip at the top — GHL leads · Ad spend · Meta conversions · Data checks · AI summary — each step turns done / warning / failed as n8n reports it. The two client cards fill in as their data arrives.
- **After a run:** agency overview — one card per client with a status light (green: all checks pass; orange: warnings; red: a step failed) and the headline numbers. Clicking a card opens that client's full report: numbers vs previous run, the AI summary, and the warnings in client-friendly words. The step strip stays as "how this was made", next to a screenshot of the n8n workflow.
- **Look:** matches the portfolio site (dark theme, same fonts, colours and gradient); works on phone and desktop.

How the page learns each step's progress (polling a status webhook by run ID, or similar) is left to the builder.

### 6.5 Error handling (required — see anti-goals)

- **Space asleep / slow to answer:** show "Waking up the demo server — this takes about a minute" with progress, not a frozen page; retry automatically.
- **A step fails** (GHL, Meta or the AI is down, or returns bad data): the step shows as failed with a plain reason; the run still produces a report from what it has, clearly marked partial. If nothing usable comes back, show the last successful run with a note.
- **Invalid AI output:** validate it; if invalid, retry once, then fall back to a template summary built from the numbers.
- **Run limit reached:** clear message with when to try again; show the latest report meanwhile.
- n8n's own error workflow logs every failure with its run ID.

### 6.6 Security and limits

- n8n owner account created immediately after first start; editor never public.
- The Space must be public so the webhook is reachable; only the demo webhook(s) are exposed.
- Run limits: one run at a time, a minimum gap between runs, and a daily cap. Exact numbers: builder's call.
- API keys (GHL, Meta, AI) live only in n8n credentials / Space secrets, never in the page.
- CORS on the webhook limited to the portfolio site's origin.

### 6.7 Deliverables

1. The n8n workflow(s), exported as JSON into this repo.
2. The demo page on the portfolio site, plus a new project card linking to it.
3. **Troubleshooting guide** for a non-technical account manager: how to tell something is wrong, what each warning means, what to try, when and how to escalate. Plain English.
4. A short README: what it is, what's live vs simulated, how to set it up from scratch.
5. Portfolio updates once it works: skills list ("n8n" without "learning"), profile.md, application notes.

## 7. Constraints

- Free only. No card if avoidable (Hugging Face, Supabase, GHL sandbox, Meta test events).
- Sandbox fair use: low volume.
- The Space sleeps after 48 h idle; first visit after that waits about a minute.
- Hugging Face disk is not persistent — nothing important may live only on the Space's disk.
- Every claim on the site about this project must match what actually runs.

## 8. My calls (Claude) — check these

- Demo page lives on the portfolio site as its own page, linked from a new project card.
- Automatic clean-up of old demo leads, and run limits.
- Deliberately flawed demo leads so the checks find something.
- Data checks listed in §6.3 step 6.
- AI receives aggregates only; template fallback if its output is invalid.
- Partial reports instead of failing pages; latest report shown before any run.
- Clear labelling of live vs simulated data on the page.
- Matching the portfolio's visual style; phone + desktop testing.

## 9. Left to the builder

- Exact n8n node layout, sub-workflows, and how progress reaches the page.
- Demo-lead generator details, client names (fictional), KPI formulas' edge cases.
- Exact run-limit numbers and clean-up age.
- Repo structure.

## 10. Open, decide later (Ibrahim)

- AI model for the summary (should have a free tier).
- Video walkthrough: captions only or AI voice, or none — no face, no voice of his own.
