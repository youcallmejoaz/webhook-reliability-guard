# Plan: webhook-reliability-guard

A safety net that sits between a store or CRM and the tools that act on its events (membership site, email sender, n8n). It saves every event the moment it arrives, delivers it with retries, double checks every 15 minutes that nothing slipped through, and explains repeated failures in plain English.

## Architecture

One Node process (TypeScript, Hono) with five parts that share one SQLite database file:

```
 store / CRM ──signed webhook──▶ Receiver ──(save first, then 200)──▶ events + deliveries tables
                                                                         │
                         ┌───────────────────────────────────────────────┘
                         ▼
                   Delivery worker ──Idempotency-Key──▶ membership site, email sender, n8n
                     │  retries with exponential backoff, dead letter after the limit
                     ▼
                Incident detector ──masked context──▶ Claude (explain only) ──▶ Slack (mock in demo)

 Reconciliation (every 15 min) ──asks source for recent purchases──▶ compares with destinations
                                  └─▶ missing ones are re-queued and logged as silent misses
 Buyer list sync ──▶ Google Sheets adapter (CSV file in demo)
 Email check ──▶ SPF, DKIM, DMARC via node:dns (fixtures in demo) + bounces from the send log
 Dashboard (static HTML + JSON API on the same server)
```

In demo mode the same process also hosts the mock store, mock membership site, mock email sender, mock n8n webhook and mock Slack channel under `/mock/*`, so everything runs with zero keys.

### Decisions and why

- **SQLite (built in `node:sqlite`) instead of Postgres.** The brief allows SQLite in demo. Jobs are claimed with one atomic `UPDATE ... WHERE id IN (SELECT ...) RETURNING`, which gives the same guarantee as `FOR UPDATE SKIP LOCKED` for a single process. Postgres is listed under Later.
- **Dashboard is static HTML and vanilla JS served by Hono, not Next.js.** It is one process, one port, no build step, and nothing a client sees changes. Next.js can replace it later without touching the API.
- **Idempotency is enforced twice.** The receiver drops duplicate source events by `(source, event id)`. Every outbound delivery carries `Idempotency-Key: <source>:<event id>:<destination>`, so a timeout followed by a retry cannot create a second account or a second email. Real destinations that do not support the header need a lookup-before-create in their adapter.

## Data model (SQLite)

| Table | Key columns |
|---|---|
| `events` | id, source, external_id (unique with source), type, payload, origin (webhook, reconciliation), received_at |
| `deliveries` | id, event_id, destination (unique pair), status (pending, retrying, delivered, dead), attempts, next_attempt_at, locked_until, last_error, delivered_at |
| `timeline` | id, event_id, delivery_id, at, kind, message (the per event history the dashboard shows) |
| `rejected_webhooks` | id, source, at, reason, body_sha256 (no body stored) |
| `reconciliation_runs` | id, started_at, finished_at, checked, misses |
| `silent_misses` | id, run_id, kind (missed_webhook, destination_dropped), event_id, destination, order_id |
| `incidents` | id, pattern, destination, created_at, summary, likely_cause, suggested_fix, model |
| `slack_messages` | id, channel, at, text (mock Slack channel) |

## Folder layout

```
src/            server code (app.ts builds the Hono app, server.ts starts it)
src/mocks/      mock store, membership site, email sender, n8n, Slack, chaos settings
public/         dashboard (index.html, app.js, styles.css)
scripts/        seed, chaos, explain, check-email command line tools
fixtures/       DNS fixtures, recorded Claude answers
tests/          Vitest tests
clips/          Playwright recorder, cards, prompt replays, rendered MP4s
docs/           portfolio text and cover images
```

## Features mapped to the evidence

| Feature | Asked for in |
|---|---|
| Receiver, signature check, save before reply | Oct 24 automation fix post: webhooks missed between CRM and membership site |
| Delivery worker, retries, dead letter, replay | Oct 24 post: "retries and monitoring so a missed event gets caught"; Oct 25 post: handle errors and edge cases |
| Reconciliation every 15 minutes | Oct 24 post: login emails not reaching buyers, missed webhooks |
| Email check (SPF, DKIM, DMARC, bounces) | Oct 24 post: email authentication |
| AI incident explainer to Slack | Oct 25 post: investigate failures, document so someone else can maintain it |
| Buyer list sync to Google Sheets | Oct 24 post: always current buyer list in a Google Sheet |
| n8n destination | Oct 24 post: an n8n instance |
| Status dashboard and event timeline | Market signal S7: report progress, resume after failure |

## Test plan (Vitest)

1. Chaos: 50 buyers, 20 percent failures, 5 percent silent drops. Every buyer has exactly one account and exactly one welcome email after retries and one reconciliation run.
2. Replaying a delivered event creates no duplicate.
3. Deliveries past the retry limit go to the dead letter queue; replay delivers them.
4. Reconciliation finds every silently dropped event in the fixture.
5. DNS check: DKIM missing, SPF and DMARC pass.
6. Unsigned and badly signed webhooks are rejected and logged; stale timestamps are rejected.
7. Masking: Slack text and the Claude prompt never contain an email address or last name.
8. Demo mode end to end with no keys (covered by test 1, which runs with `DEMO_MODE=1` and no `ANTHROPIC_API_KEY`).

CI: GitHub Actions on every push runs `npm ci`, `npm run typecheck`, `npm test`.

## Build order

1. Config, database, signature helper, receiver.
2. Mock services and chaos settings.
3. Delivery worker with backoff, dead letter, replay.
4. Reconciliation.
5. Email check with DNS fixtures.
6. Incident detector, masking, Claude explainer with recorded answers, mock Slack.
7. Buyer list sync.
8. Dashboard.
9. Seed, chaos, explain scripts; tests; CI; README.
10. Clips, proposal cut, portfolio text, cover images.

## Later (not in this build)

- Postgres store with `FOR UPDATE SKIP LOCKED` for running several workers at once.
- Real source adapters (Keap, Stripe, WooCommerce) and real destination adapters (MemberPress, Memberium, Postmark).
- Login and roles for the dashboard.
- Reconciliation for tag and cancellation events, not only purchases.
