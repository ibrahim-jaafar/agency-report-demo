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
