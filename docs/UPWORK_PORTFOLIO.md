# Upwork portfolio entry

Character counts come from `node docs/count-chars.mjs`, which reads `docs/portfolio-fields.json` and checks Upwork's limits (title 70, role 100, description 600, exactly 5 skills).

## 1. Project title (pick one, 70 characters or fewer)

| Option | Characters |
|---|---|
| **Fix Missed Webhooks Between CRM, Payments and Membership Site** (recommended) | 61 |
| Webhook Monitoring: Retries, Reconciliation and AI Alerts | 57 |
| Automation Reliability System for CRM, WordPress and n8n Flows | 62 |

Recommended: the first. It names the pain ("missed webhooks") and the tools clients list in their posts. The third mentions WordPress, but the demo uses a mock membership site, not a WordPress install. Use it only if you are happy with that.

## 2. Your role (100 characters or fewer)

Automation engineer: built the webhook receiver, retries, reconciliation, alerts and email checks

**97 characters**

## 3. Project description (600 characters or fewer)

Buyers pay, but their access email never arrives because webhooks between the store, CRM and membership site get lost. A demo build on sample data: every event is saved on arrival, delivered with automatic retries, and parked for one-click replay if a tool stays down. Every 15 minutes it checks each buyer has access and fixes silent misses. Claude explains repeated failures in Slack. It also checks SPF, DKIM and DMARC and syncs a buyer list. Safeguards: no duplicates, signed webhooks only, masked customer data. 28 tests pass. Built with TypeScript, Hono, SQLite and the Claude API.

**587 characters.** The only number is the test count (28 passing, from `npm test`).

## 4. Skills (exactly 5)

Automation, Webhook, API Integration, n8n, TypeScript

If Upwork does not offer "Webhook" as a tag, swap it for "Zapier" or "Make.com", whichever it offers.

## 5. Content blocks, in this order

1. **Cover image:** `docs/upwork-cover-a.png` (1600 x 1200, 4:3).
2. **Video:** `clips/proposal_cut.mp4` (61.5 seconds, narrated).
3. **Screenshot:** `clips/stills/C04.png`. Caption: "Every 15 minutes the system compares the store with the membership site and email sender, and here it caught 3 silent misses and sent them again."
4. **Screenshot:** `clips/stills/C06.png`. Caption: "When a tool keeps failing, Claude posts a plain-English note in Slack with what happened, the likely cause and the fix."
5. **Link:** https://github.com/youcallmejoaz/webhook-reliability-guard
6. **YouTube:** _add the full video link here once it is published._

## 6. Proposal snippet

Here is a one minute demo of a safety net I built that catches every webhook between a store, CRM and membership site, retries failures and fixes silent misses, so buyers always get their access email: https://github.com/youcallmejoaz/webhook-reliability-guard/blob/main/clips/proposal_cut.mp4 (use View raw if it does not play). If your automations are dropping customers, reply here and I'll show you how it would fit your workflow.
