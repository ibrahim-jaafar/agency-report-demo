# Agency report demo

A weekly marketing report built with n8n: leads from GoHighLevel, conversions sent to Meta, data checks in plain code, and a short AI summary that can't change a number. Live page: https://ibrahim-jaafar.github.io/agency-demo/

## What is live and what is made up

- **Live:** the n8n workflow (Render), the run history (Supabase), the leads and deals saved in a GoHighLevel sandbox, the conversions sent to Meta's Conversions API (a demo dataset with no ads; Meta treats them as normal events unless its Test Events tab is open), the data checks and the Gemini summary.
- **Made up:** the two clients, their leads, the ad spend (simulated per campaign) and the mistakes a visitor chooses.
- **Limits:** one run at a time, one a minute, 50 a day. Gemini's free tier allows 20 requests a day per model; each run asks Flash-Lite first (it answers in seconds) and Flash only if Lite's answer fails, so about 20 runs a day get an AI summary and later runs use the template. Flash was left as the backup because on the free tier it often takes over a minute or is overloaded.
- **AI summary:** the AI never types a number. It writes placeholders such as `{costPerLead}` or `{leads_change}`, and code puts in the real values (`$22.34`, `up 20%`), so a number in the summary can't be wrong. An answer is refused if it types a digit, uses a placeholder that doesn't exist or has no value this week, writes "rose" or "fell" next to a change (the change already says up or down), or is too long once filled in. Each placeholder must also have its own label within a few words of it ("cost per lead was {costPerLead}"), so a real number can't be put under the wrong name; the AI gets a guide made from the same word lists the check uses. The template summary uses the same placeholders and the same check.
- **GoHighLevel limit:** our sandbox token allows 25 requests per 10 seconds per sub-account (its `X-RateLimit-*` headers say so; the docs say 100) and 10,000 a day. GoHighLevel has no bulk create for contacts or deals, so a run sends one request per record, 2 a second. Anything refused (429) is sent once more after a 10-second pause. Reads page at 2 requests a second too; deals stop paging once they reach back before the report's week.
- **Cleanup:** after the report is saved, each run deletes up to 25 demo contacts older than 7 days per sub-account (their deals go with them). It runs there and not on a schedule because the free server sleeps.
- When something looks wrong, see [docs/troubleshooting.md](docs/troubleshooting.md).

## Code

- `lib/`: the logic (scenario, leads, spend, KPIs, checks, Meta events, AI input, placeholders and their check, report). No dependencies.
- `npm test`: runs the tests (`node --test`).
- `node --test agency-demo/app.test.mjs` (in the portfolio repo): tests the demo page helpers.
- `npm run site`: copies `lib/` into the portfolio's `agency-demo/lib/`.

## Hosting setup

1. **Database (Supabase, free):** create a project in Central EU, then run `db/schema.sql` in the SQL editor. n8n connects through the **Session pooler** (port 5432), because Render can't reach the direct IPv6 address.
2. **n8n (Render, free):** create a new Web Service from the existing image `docker.io/n8nio/n8n:2.43.8` in Frankfurt on the Free plan, and set the variables from `deploy/render.env.example`. You type the two secrets yourself; they never go in this repo.
3. **Create the n8n owner account as soon as the service is live**, because until then anyone who opens the URL can claim it.
4. **Free-plan limits:**
   - The service sleeps after 15 minutes with no traffic and takes about a minute to wake up.
   - 750 free hours a month covers one service.
   - The GoHighLevel test account expires on 2027-04-19.

Keys (GoHighLevel, Meta, Gemini) are stored only in n8n credentials.

## Workflows

- **demo-run** (the demo only): checks the limits, answers the page, makes up the week's customers and saves them in GoHighLevel, waits until GoHighLevel's search finds every contact it saved (search lags behind saves, sometimes by more than 20 seconds; checked every 5 s, up to 12 times), then calls the weekly report and waits for it, then deletes old demo contacts. For a real client this part goes away.
- **weekly-report** (what a real client would get): reads the contacts and deals back from GoHighLevel, 100 per page, as many pages as there are (up to 100 pages each; past that the report says it read only part), sends the conversions to Meta, runs the checks, has the AI write the summary and saves the report. It never writes to GoHighLevel and doesn't know the data is fake. For a real client it would select contacts by date instead of by the run's tag, and read ad spend from Meta's Insights API instead of the simulated spend the demo passes in.
- **demo-status** answers the page's progress checks; **error-handler** marks a run failed if either workflow crashes.
- **Slack alerts:** the report posts to a Slack channel when a step failed or a check fired (clean runs stay quiet), and the error workflow posts when a run crashes. It uses Slack's chat.postMessage with a bot token kept in an n8n credential; the Slack nodes are only built when `N8N_CRED_SLACK` and `SLACK_CHANNEL` are in `.env`.

- Edit `scripts/make-templates.mjs` (not the JSON), then `node scripts/make-templates.mjs` → `workflows/src/`.
- `node scripts/deploy.mjs` builds `dist/` (tested `lib/` pasted into the Code nodes) and uploads/publishes the 4 workflows (it puts the weekly report's n8n id into demo-run). It needs `N8N_API_KEY` plus the IDs in `.env` (credential IDs, GHL location/pipeline/stage IDs, Meta dataset, test code).
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
| Save a lead | `POST https://services.leadconnectorhq.com/contacts/` (header `Version: 2021-07-28`; tags `demo`, `run:<runId>`, `created:<epoch ms>`) |
| Save a booking/order | `POST /opportunities/` (status `won`, or `lost` when cancelled; `monetaryValue`) |
| Find demo contacts older than 7 days | `POST /contacts/search` (tag filter + `dateAdded` range, oldest first) |
| Delete them | `DELETE /contacts/<id>` (GoHighLevel removes their deals too) |
| Conversions | `POST https://graph.facebook.com/v23.0/<dataset>/events` with `test_event_code` |
| AI summary | `POST https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`, `gemini-flash-lite-latest` first, then `gemini-flash-latest` only if Lite's answer fails (45 s limit each), strict JSON schema |

GoHighLevel's search lags a few seconds behind new contacts, so a run builds its report from the records GoHighLevel returns when they're saved, not from a search.
