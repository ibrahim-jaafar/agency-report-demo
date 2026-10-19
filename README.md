# Agency report demo

A weekly marketing report built with n8n: leads from GoHighLevel, conversions sent to Meta, data checks in plain code, and a short AI summary that can't change a number. Live page: https://ibrahim-jaafar.github.io/agency-demo/

## Code

- `lib/`: the logic (scenario, leads, spend, KPIs, checks, Meta events, AI input/validation, report). No dependencies.
- `npm test`: runs the tests (`node --test`).
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

- Edit `scripts/make-templates.mjs` (not the JSON), then `node scripts/make-templates.mjs` → `workflows/src/`.
- `node scripts/deploy.mjs` builds `dist/` (tested `lib/` pasted into the Code nodes) and uploads/publishes the 3 workflows. It needs `N8N_API_KEY` plus the IDs in `.env` (credential IDs, GHL location/pipeline/stage IDs, Meta dataset, test code).
- To test the demo page from your own machine, build with `DEMO_EXTRA_ORIGIN=http://localhost:8765 node scripts/make-templates.mjs`, deploy, test, then build and deploy again without it.
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
| AI summary | `POST https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`, model `gemini-flash-latest`, strict JSON schema |

GoHighLevel's search lags a few seconds behind new contacts, so a run builds its report from the records GoHighLevel returns when they're saved, not from a search.
