# When the report looks wrong

This guide is for the account manager who reads the report before it goes to a client. You don't need to know how the workflows are built.

## How to tell something is wrong

- **The light next to each client's name** (the tabs above the dashboard) is the latest run's:
  - Green: every check passed on the run's 7 days.
  - Orange: the data has a problem. Read the warnings in Data health before sending anything.
  - Red: a step failed, so the numbers may be incomplete. Don't send this report.
- **Data health** on every view runs the same checks on the period on screen: today, a week, a month or a year. A year can show a warning from a few months ago; the run's own days show the run's warnings.
- **The bar at the top** shows the step a run is on while it runs, then how it ended: "✓ Done · all checks passed", "✓ Done · N warnings", "Done, but a step failed: …" (with the reason), or "The run hit an error and stopped at: …". After "Send a test lead" it says what happened to that lead.
- **The AI summary card** says who wrote the summary. "Written by the template" means the AI's answer was refused or the AI didn't answer, and the card says which. The numbers are still correct either way (code fills them in for the AI and the template); only the wording is plainer.
- **The ? button → Latest run:** "Partial report" means a step failed and the report was built without it.

## What each warning means and what to do

| Warning | What it means | What to do |
|---|---|---|
| Leads with no source | The CRM lost which ad brought these leads. | Ask whoever manages the forms to check that every form passes the ad source. Treat cost per lead as rough until it's fixed. |
| Leads that appear twice | The same person was saved twice, written differently (for example +961 vs 0, or capital letters). | Merge the duplicates in GoHighLevel. Until then, lead counts look better than they are. |
| Meta and CRM don't match | Some bookings or orders in the CRM never reached Meta. | Meta will optimise ads on less data. Send the run's time to whoever looks after the integration. |
| Totals don't add up | The account's total spend is not the sum of its campaigns. | Don't quote the spend figures to the client until someone checks the ad account. |
| Unusually large order | One order is far bigger than the others. | Check in GoHighLevel that the amount is real and not a typo before reporting revenue. |
| Meta rejected an event | Meta refused a conversion, usually because it is more than 7 days old. | Nothing to fix for this period; if it happens every week, report it. |

## What to try first

1. **Run the report again** after a minute. Many failures are a service having a short outage.
2. **The first visit in a while is slow.** The free server sleeps after 15 minutes with no visitors and takes up to 4 minutes to wake up. The page says so while it waits; a summary asked for while it sleeps takes as long.
3. **"Written by the template: the AI didn't answer (… 503)"** means Gemini was busy. Press "Ask Gemini again" a minute later.
4. **Check the service status pages** if a step keeps failing:
   - GoHighLevel: https://status.gohighlevel.com
   - Meta: https://metastatus.com
   - Gemini: https://aistudio.google.com/status
   - Render (the server): https://status.render.com

## When and how to escalate

Escalate when the same step fails twice in a row, or a red light stays after a rerun. Send:

- the **time** you ran it (the maintainer finds the run by its time),
- a **screenshot** of the bar at the top and the client's view with Data health.
