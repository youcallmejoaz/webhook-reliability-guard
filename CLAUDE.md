# CLAUDE.md

## What this project is

webhook-reliability-guard is a safety net for business automations. It receives signed webhooks from a store or CRM, saves each one before replying, delivers it to the membership site, email sender and n8n with retries, reconciles every 15 minutes against the source, checks email authentication, keeps a buyer list in sync, and asks Claude to explain repeated failures in plain English in Slack. See `PLAN.md` for the architecture and data model.

## Folder map

- `src/app.ts` builds the Hono app; `src/server.ts` starts it with the worker and schedulers.
- `src/receiver.ts` webhook endpoint, `src/signature.ts` HMAC signing and checking.
- `src/worker.ts` delivery worker, backoff, dead letter, replay. `src/destinations.ts` outbound adapters.
- `src/reconcile.ts` reconciliation job, `src/sources.ts` source adapters.
- `src/emailcheck.ts` SPF, DKIM, DMARC and bounce check.
- `src/incidents.ts` failure pattern detection, `src/explainer.ts` Claude call, `src/mask.ts` masking, `src/slack.ts` Slack poster.
- `src/buyers.ts` buyer list sync (CSV in demo, Google Sheets adapter).
- `src/mocks/` mock store, membership site, email sender, n8n, Slack and chaos settings.
- `public/` dashboard. `scripts/` command line tools. `fixtures/` DNS and recorded Claude answers. `tests/` Vitest.
- `clips/` video clips and their recorder. `docs/` portfolio text and cover images.

## Commands

- Install: `npm ci` (always from the lockfile)
- Start: `npm run dev` (or `docker compose up`), then open http://localhost:3000
- Seed: `npm run seed` (resets the demo database and loads 50 fictional buyers)
- Chaos test: `npm run chaos -- --fail 0.2 --drop 0.05` (server must be running)
- Ask why something failed: `npm run explain -- "Why did the welcome emails fail last night?"`
- Email check: `npm run check-email`
- Test: `npm test`; typecheck: `npm run typecheck`
- Clips: `npm run clips` (needs ffmpeg and Playwright). Proposal cut: `python3 clips/tts.py` then `python3 clips/render_proposal_cut.py`. Covers: `node docs/cover/render.mjs`

## Conventions

- TypeScript, ES modules, Node 22.13 or newer. Times are stored as epoch milliseconds.
- `DEMO_MODE=1` is the default and must keep working with zero API keys.
- Keep dependencies pinned to exact versions and commit `package-lock.json`.
- Plain English in anything a business owner reads (dashboard, Slack, README). No em dashes, no emojis.

## Hard rules (guardrails)

1. Every event is stored durably before the receiver replies. If the save fails, reply with an error so the source retries.
2. Processing is idempotent. Duplicate source events are ignored, and every outbound call carries an `Idempotency-Key`. Retries and replays must never create a duplicate account or a second welcome email.
3. Claude only reads and explains. It gets no tools, cannot change settings, and cannot replay. Replays happen only from code paths a person or the reconciliation job triggers.
4. Webhook signatures are verified. Unsigned or badly signed events are rejected with 401 and logged without their body.
5. Buyer data sent to Slack or to Claude is masked to first name and order number. Never send an email address, last name or full payload.
6. Never commit secrets. `.env` is ignored; document every variable in `.env.example` instead. No real client data, emails or personal paths anywhere in the repo.
