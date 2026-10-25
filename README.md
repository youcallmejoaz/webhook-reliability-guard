# Webhook Reliability Guard

**A safety net for your automations: every purchase, sign-up and tag change between your tools is caught, retried, double checked and explained in plain English, so customers never miss their access email again.**

## The problem

A customer pays. The access email never arrives. Nobody knows until they complain.

If your store or CRM talks to a membership site, an email sender, n8n, Zapier or Make, those messages (webhooks) get lost more often than you think. A tool is busy for a minute, a request times out, or a tool says "ok" and then does nothing. Most setups send each message once and hope.

## What it does

- **Catches every event.** Each purchase, tag or cancellation from your store or CRM is saved the moment it arrives, before anything else happens.
- **Retries until it works.** If the membership site or email sender is down, it tries again with a growing pause between tries. If it still fails, it parks the event in a "dead letter" list where you replay it with one click.
- **Double checks every 15 minutes.** It asks your store for recent purchases and checks that every buyer really has an account and a welcome email. Anything that slipped through is sent again automatically.
- **Explains problems in plain English.** When something keeps failing, Claude reads the logs and posts a short note in Slack: what happened, the likely cause, and what to fix.
- **Checks your email setup.** SPF, DKIM and DMARC records for your sending domain, plus bounces, with the exact record to add when one is missing.
- **Keeps your buyer list current.** An always up to date list of buyers, their access and tags, pushed to Google Sheets.
- **Shows it all on one screen.** Events today, delivered, retrying, dead letter, silent misses caught, and the full story of any single order.

## How it works, in 4 steps

1. Every event from the store or CRM is saved the moment it arrives, before anything else happens.
2. It is delivered to each tool that needs it. If a tool is down, it retries until it works or flags it for a person.
3. Every 15 minutes the system double checks that every buyer actually has access, and fixes any that were missed.
4. When something keeps failing, Claude explains what happened and what to fix, in plain English, in Slack.

## Safeguards

- **Saved before anything else.** The event is stored before the store gets its "received" reply. If saving fails, the store is told to try again.
- **No duplicates.** Duplicate webhooks are ignored, and every delivery carries an idempotency key, so retries and replays never create a second account or a second welcome email. The tests check this under 20% failures.
- **Claude explains, never acts.** Claude only reads masked logs and writes an explanation. It cannot change settings or replay anything.
- **Only signed messages get in.** Webhooks without a valid signature are rejected and logged (without their content).
- **Customer data is masked.** Slack messages and anything sent to Claude contain first names and order numbers only.

## Demo

- Proposal cut (60 to 90 seconds): [clips/proposal_cut.mp4](clips/proposal_cut.mp4)
- Full walkthrough on YouTube: _link coming soon_
- All clips: [clips/MANIFEST.md](clips/MANIFEST.md)

## Try it on your computer

You need Node.js 22.13 or newer. No API keys needed: demo mode runs on sample data with mock tools.

```bash
npm ci
npm run dev          # starts everything on http://localhost:3000
```

Open http://localhost:3000 and press **Start chaos test**. Then, in a second terminal:

```bash
npm run chaos -- --fail 0.2 --drop 0.05     # the same test from the command line, with a summary
npm run explain -- "Why did the welcome emails fail last night?"
npm run check-email
npm run seed                                 # start over with 50 fresh fictional buyers
```

Or with Docker: `docker compose up`.

### Going live

Copy `.env.example` to `.env`, set `DEMO_MODE=0`, and fill in the webhook secret, the addresses of your membership site, email sender and n8n webhook, your Slack webhook, your Anthropic API key and your Google Sheet. Each real tool needs a short adapter for its signature format and API; see `src/destinations.ts` and `src/sources.ts` for the shape.

## Architecture

One small Node.js service (TypeScript, Hono) with a SQLite database:

| Part | File | What it does |
|---|---|---|
| Receiver | `src/receiver.ts` | Checks the HMAC signature, stores the event and one delivery per tool in one transaction, then replies |
| Delivery worker | `src/worker.ts` | Claims due deliveries atomically, sends them with an `Idempotency-Key`, retries with exponential backoff and jitter, dead letters after the limit |
| Reconciliation | `src/reconcile.ts` | Every 15 minutes compares the store's recent purchases with what each tool actually has; re-queues anything missing |
| Incidents | `src/incidents.ts`, `src/explainer.ts` | Spots repeated failures, asks Claude (Haiku) for a plain-English explanation from masked facts, posts to Slack |
| Email check | `src/emailcheck.ts` | SPF, DKIM, DMARC via DNS, bounces from the send log |
| Buyer list | `src/buyers.ts` | Builds the buyer list and pushes it through a CSV or Google Sheets adapter |
| Dashboard | `public/` | Static page reading the JSON API in `src/api.ts` |
| Demo tools | `src/mocks/` | Mock store, membership site, email sender and n8n that can fail, time out or silently drop on purpose |

More detail in [PLAN.md](PLAN.md).

## Tests

```bash
npm test
```

27 tests, including:

- With 20% failures and 5% silent drops, all 50 fictional buyers end up with access and exactly one welcome email.
- Replaying an already delivered event creates no duplicate.
- Deliveries past the retry limit land in the dead letter queue, and replay delivers them.
- A timeout after the tool already did the work does not cause a duplicate.
- Reconciliation finds every silently dropped event in the fixture, and nothing else.
- The email check reports the missing DKIM record and passes SPF and DMARC.
- Unsigned, wrongly signed, old and tampered webhooks are rejected.
- No email address or last name reaches Slack or Claude.

CI runs typecheck and tests on every push (GitHub Actions).

## Honest limits

- Each real source and destination needs a short adapter (signature format, API for reconciliation). The demo ships mocks plus the adapter shape.
- Reconciliation covers purchases. Tags and cancellations are delivered with retries but not yet double checked.
- Fixing DNS records is done by you or with your access. The tool tells you exactly what to change.
- One process with SQLite. For several workers at once, move to Postgres (planned).
- Running cost (estimate): one small container and a database; Claude summaries cost fractions of a cent each.
