# When the weekly report looks wrong

This guide is for the account manager who reads the report before it goes to a client. You don't need to know how the workflow is built.

## How to tell something is wrong

- **The lights on each client card**
  - Green: every check passed and the report can be sent.
  - Orange: the data has a problem. Read the warnings on the card before sending anything.
  - Red: a step failed, so the numbers may be incomplete. Don't send this report.
- **"Partial report"** under the summary means a step failed and the report was built without it.
- **"This summary was written by the template"** means the AI's answer was refused or the AI didn't answer. The numbers are still correct; only the wording is plainer.
- **The workflow strip** shows each step: green is done, orange is done with a warning, red failed (its reason is written under it), and grey "Stopped" means the run ended before reaching that step.

## What each warning means and what to do

| Warning | What it means | What to do |
|---|---|---|
| Leads with no source | The CRM lost which ad brought these leads. | Ask whoever manages the forms to check that every form passes the ad source. Treat cost per lead as rough until it's fixed. |
| Leads that appear twice | The same person was saved twice, written differently (for example +961 vs 0, or capital letters). | Merge the duplicates in GoHighLevel. Until then, lead counts look better than they are. |
| Meta and CRM don't match | Some bookings or orders in the CRM never reached Meta. | Meta will optimise ads on less data. Send the run ID to whoever looks after the integration. |
| Totals don't add up | The account's total spend is not the sum of its campaigns. | Don't quote the spend figures to the client until someone checks the ad account. |
| Unusually large order | One order is far bigger than the others. | Check in GoHighLevel that the amount is real and not a typo before reporting revenue. |
| Meta rejected an event | Meta refused a conversion, usually because it is more than 7 days old. | Nothing to fix for this week; if it happens every week, report it. |

## What to try first

1. **Run the report again** after a minute. Many failures are a service having a short outage.
2. **The first run of the day is slow.** The free server sleeps when unused and takes about a minute to wake up. The page says so while it waits.
3. **Check the service status pages** if a step keeps failing:
   - GoHighLevel: https://status.gohighlevel.com
   - Meta: https://metastatus.com
   - Gemini: https://aistudio.google.com/status
   - Render (the server): https://status.render.com

## When and how to escalate

Escalate when the same step fails twice in a row, or a red light stays after a rerun. Send:

- the **run ID** (in the page address after a run, or ask the person who maintains the workflow to look up the latest run),
- the **time** you ran it,
- a **screenshot** of the workflow strip and the client cards.
