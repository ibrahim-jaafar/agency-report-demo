# Agency report demo

A marketing report built with n8n: leads from GoHighLevel, conversions sent to Meta, data checks in plain code, a dashboard for any day, week, month or year, and a short AI summary on request that can't change a number. Live page: https://ibrahim-jaafar.github.io/agency-demo/

## What is live and what is made up

- **Live:** the n8n workflows (Render), the run history and kept AI summaries (Supabase), the leads and deals saved in a GoHighLevel sandbox, the conversions sent to Meta's Conversions API (a demo dataset with no ads; Meta treats them as normal events unless its Test Events tab is open), the data checks and the Gemini summaries.
- **Made up:** the two clients, their leads, the ad spend, impressions and clicks (simulated per campaign), the mistakes a visitor chooses, the budgets, the daily history outside the run's 7 days (with its people and the odd planted problem).
- **Made up on purpose:** all leads are made up so the demo can be run and broken freely without any real patient's details ever entering GoHighLevel, Meta or the AI. For a real clinic I'd keep testing on made-up data the same way.
- **The run:** makes the leads of the last 7 days up to the moment of the run (today so far and the 6 days before: Meta takes conversions up to 7 days old, and no lead is dated in the future), saves them in GoHighLevel, reads them back, sends the conversions to Meta and runs the checks. It saves the 7 days day by day and per campaign (`report.clients[].days`, `lib/daily.js` `runDays`): leads, conversions and revenue counted from the CRM leads by day, each campaign's simulated spend, impressions and clicks shared out over the days, and what the checks need per day (the gap between the account's total and its campaigns shared by spend; conversions Meta never got on days that had conversions; Meta's refusals on the last day). The report keeps `ranAt` (the run's moment) and `asOf` (how far today goes: the run, or the latest test lead).
- **Dashboard:** each client has Day, Week, Month and Year views. Each opens on the current period so far (UTC: today, this week, this month, this year), refreshed every 30 s and compared with the same stretch before up to the same time of day; ‹ › step back to whole earlier periods, back to the start of the made-up history (1 Jan 2025). Day is compared with the same day a week before (weekends are quieter; a switch compares it with the day before instead), Week with the week before, Month and Year with the same days of last month or last year. Every view has cards with their change (green when it's good news), a funnel, spend and paid leads per campaign with cost per paid lead, charts, spend against a made-up budget (monthly, shared out by day for Day and Week), the AI summary card, Data health, the list of leads behind its numbers and a Download CSV button. All of it comes from `periodFigures` (`lib/daily.js`): daily rows (the run's real days plus made-up history from `historyDay`, the same every time and made with a run's own rates: lead volume, campaign shares, conversion and cancellation rates, quieter weekends) added up, with costs and rates worked out again from the sums, never averaged. Today's leads and results are counted from the people who came in before `asOf`: the clock, or on a run day the run's moment (after a run nothing arrives on its own, until a test lead). Today's spend, impressions and clicks follow the hourly curve the made-up leads arrive by. The address keeps the client, the period and how far back (`#client=store&period=month&back=1`). There is no daily table in Supabase: the server sleeps, so nothing could fill it on a schedule; a real client would store each day's totals and take live numbers from GoHighLevel webhooks and Meta's hourly spend.
- **Data health for any period:** `periodChecks` runs the run's own rules (`lib/checks.js` `warningsFrom`, shared with `runChecks`) on the period's leads and days, so the run's 7 days give exactly the run's warnings. The made-up history has the odd problem planted from its own random numbers, about as often as a real account: a lead whose source was lost, someone enquiring twice the same day, a huge store order, an account total that's off, a conversion Meta never got or refused.
- **AI summary on request:** "Generate AI summary" on any view asks the `demo-summary` workflow. The page sends only which period (period, how far back, Day's comparison): the server works the figures out itself from the latest report with `periodFigures`, so nobody can feed the AI their own numbers or words. One answer covers both clients. The AI is told what the period covers and what it's compared with, in words (`periodWords`, never digits), and whether it's still under way ("so far"). It never types a number: it writes placeholders such as `{costPerLead}` or `{leads_change}`, and code puts in the real values (`$22.34`, `up 20%`), so a number in the summary can't be wrong. Each warning starts with the check's own sentence (`{duplicates_message}`), and the AI adds what it means in plain words. An answer is refused if it types a digit, uses a placeholder that doesn't exist or has no value, writes "rose" or "fell" next to a change (the change already says up or down), compares with a different time than the period's own ("last week" in a day view), or is too long once filled in. Each placeholder must also have its own label within a few words of it ("cost per lead was {costPerLead}"), so a real number can't be put under the wrong name; the AI gets a guide made from the same word lists the check uses. When both Gemini models' answers fail (or Gemini is busy), the template writes the summary with the same placeholders and the same check, and the card says why. "Simulate a broken AI answer" replaces Gemini's reply with a refusal, so the template takes over.
- **Test leads:** after a run, "Send a test lead" (`demo-lead`) makes one customer arriving now for the client on screen, saves them (and a deal when they book, order, cancel or get a refund) in GoHighLevel, sends a booking or order to Meta, and adds them to the latest run: its list, today's figures and `asOf`. Only onto a run from today, one every 5 seconds, 30 a run, and only if nothing changed the run in between (two at once can't overwrite each other).
- **Limits:** one run at a time, one a minute, 50 a day. Gemini's free tier allows 20 requests a day per model; each summary asks Flash-Lite first (it answers in seconds) and Flash only if Lite's answer fails. Summaries are kept in `demo_summaries`: a finished period is written once per run, one still under way once an hour (or until a test lead moves today on); after 40 new ones in a day the template writes them. Flash is the backup because on the free tier it often takes over a minute or is overloaded.
- **GoHighLevel limit:** our sandbox token allows 25 requests per 10 seconds per sub-account (its `X-RateLimit-*` headers say so; the docs say 100) and 10,000 a day. GoHighLevel has no bulk create for contacts or deals, so a run sends one request per record, 2 a second. Anything refused (429) is sent once more after a 10-second pause. Reads page at 2 requests a second too; deals stop paging once they reach back before the run's 7 days.
- **Cleanup:** after the report is saved, each run deletes up to 25 demo contacts older than 7 days per sub-account (their deals go with them), test leads included. It runs there and not on a schedule because the free server sleeps.
- When something looks wrong, see [docs/troubleshooting.md](docs/troubleshooting.md).

## Code

- `lib/`: the logic (scenario, leads, spend, KPIs, daily totals, periods and their figures, checks, Meta events, AI input, placeholders and their check, report, test leads). No dependencies.
- `npm test`: runs the tests (`node --test`).
- `node --test agency-demo/app.test.mjs` (in the portfolio repo): tests the demo page helpers (dashboard, periods, charts data, toolbar). 154 logic + 50 page tests.
- `npm run site`: copies `lib/` into the portfolio's `agency-demo/lib/`.

## Hosting setup

1. **Database (Supabase, free):** create a project in Central EU, then run `db/schema.sql` in the SQL editor. n8n connects through the **Session pooler** (port 5432), because Render can't reach the direct IPv6 address. The summary workflow makes its own `demo_summaries` table the first time it runs.
2. **n8n (Render, free):** create a new Web Service from the existing image `docker.io/n8nio/n8n:2.43.8` in Frankfurt on the Free plan, and set the variables from `deploy/render.env.example`. You type the two secrets yourself; they never go in this repo.
3. **Create the n8n owner account as soon as the service is live**, because until then anyone who opens the URL can claim it.
4. **Free-plan limits:**
   - The service sleeps after 15 minutes with no traffic and takes up to 4 minutes to wake up (measured: 3 min 45 s).
   - 750 free hours a month covers one service.
   - The GoHighLevel test account expires on 2027-04-19.

Keys (GoHighLevel, Meta, Gemini) are stored only in n8n credentials.

## Workflows

- **demo-run** (the demo only): checks the limits, answers the page, makes up the last 7 days' customers and saves them in GoHighLevel, waits until GoHighLevel's search finds every contact it saved (search lags behind saves, sometimes by more than 20 seconds; checked every 5 s, up to 12 times), then calls the report and waits for it, then deletes old demo contacts. For a real client this part goes away.
- **weekly-report** (what a real client would get): reads the contacts and deals back from GoHighLevel, 100 per page, as many pages as there are (up to 100 pages each; past that the report says it read only part), sends the conversions to Meta, runs the checks and saves the report. It never writes to GoHighLevel and doesn't know the data is fake. For a real client it would select contacts by date instead of by the run's tag, and read ad spend from Meta's Insights API instead of the simulated spend the demo passes in.
- **demo-summary** writes the AI summary for the period the page names (see above); **demo-lead** sends a test lead; **demo-status** answers the page's progress checks; **error-handler** marks a run failed if the run crashes.
- **Slack alerts:** the report posts to a Slack channel when a step failed or a check fired (clean runs stay quiet), and the error workflow posts when a run crashes. It uses Slack's chat.postMessage with a bot token kept in an n8n credential; the Slack nodes are only built when `N8N_CRED_SLACK` and `SLACK_CHANNEL` are in `.env`.

- Edit `scripts/make-templates.mjs` (not the JSON), then `node scripts/make-templates.mjs` → `workflows/src/`.
- `node scripts/deploy.mjs` builds `dist/` (tested `lib/` pasted into the Code nodes; a test compiles every node with it, so a name that clashes with the lib fails before deploying) and uploads/publishes the 6 workflows (it puts the report's n8n id into demo-run). It needs `N8N_API_KEY` plus the IDs in `.env` (credential IDs, GHL location/pipeline/stage IDs, Meta dataset, test code).
- To test the demo page from your own machine, build with `DEMO_EXTRA_ORIGIN=http://localhost:8765 node scripts/make-templates.mjs`, deploy, test, then build and deploy again without it.
- Test-only switches for the same build step: `GHL_BATCH=25` (no pacing), `GHL_TEST_FLOOD=30` (extra lookups that push a run over the GoHighLevel limit, to test the retry) and `CLEANUP_HOURS=1` (clean up contacts older than an hour). Build and deploy again without them afterwards.
- n8n credentials (all **Header Auth**, `Authorization: Bearer <token>`, except the database): `Supabase demo` (Postgres, SSL require + ignore certificate), `GHL clinic`, `GHL store`, `Meta CAPI`, `Gemini`.

## One-time GoHighLevel setup per client sub-account

- Private Integration "n8n demo" with View/Edit Contacts and View/Edit Opportunities.
- Pipeline "Demo leads" with stages New lead → Consultation booked (clinic) / Ordered (store). The tokens can't create pipelines.
- Settings → Business Profile → **Allow Duplicate Contact** on, otherwise the "duplicates" test can't reach the CRM.

## External APIs used

| Call | Endpoint |
|---|---|
| Save a lead | `POST https://services.leadconnectorhq.com/contacts/` (header `Version: 2021-07-28`; tags `demo`, `run:<runId>`, `created:<epoch ms>`; a test lead also `test-lead`) |
| Save a booking/order | `POST /opportunities/` (status `won`, or `lost` when cancelled; `monetaryValue`) |
| Find demo contacts older than 7 days | `POST /contacts/search` (tag filter + `dateAdded` range, oldest first) |
| Delete them | `DELETE /contacts/<id>` (GoHighLevel removes their deals too) |
| Conversions | `POST https://graph.facebook.com/v23.0/<dataset>/events` with `test_event_code` |
| AI summary | `POST https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`, `gemini-flash-lite-latest` first, then `gemini-flash-latest` only if Lite's answer fails (45 s limit each), strict JSON schema |

GoHighLevel's search lags behind new contacts, so demo-run waits until the search finds every contact it saved before the report reads them back.
