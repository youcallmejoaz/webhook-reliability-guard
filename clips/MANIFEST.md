# Clip manifest

All clips: 1920 x 1080, H.264, yuv420p, 30 fps, no audio. Recorded with `npm run clips` (`clips/record.mjs`) from the app in demo mode on fictional sample data. The mid frame of each clip is extracted to `clips/frames/` for checking, which is ignored by git. PNG stills for thumbnails and the portfolio are in `clips/stills/` and `clips/cards/`.

| Clip ID | File | Duration | What it shows | Video section |
|---|---|---|---|---|
| K01 | `K01_problem.mp4` | 6.6 s | Card: "A customer pays. The access email never arrives. Nobody knows until they complain." | The problem |
| P01 | `P01_build_prompt.mp4` | 11.5 s | Terminal replay: SHOW prompt 1 typed, the 8 point plan appears | How I built it |
| C01 | `C01_chaos_start.mp4` | 8.8 s | Dashboard: the chaos test is started, 50 purchases stream into the terminal panel, the first cards appear | How it works |
| C02 | `C02_failures_retrying.mp4` | 11.3 s | Red failed deliveries and climbing retry counters (Email x2, x3, x4) during a 9 second email outage plus 20% random failures | How it works |
| C03 | `C03_retries_succeed.mp4` | 8.5 s | Retries go through one by one, red turns green, Retrying drops to 0, a few land in the dead letter queue | How it works |
| C04 | `C04_reconciliation.mp4` | 12.6 s | Reconciliation tab: "Run check now" finds 3 silent misses (one lost webhook, two "ok but not saved"), replays them, Silent misses caught goes to 3 | How it works |
| C05 | `C05_dead_letter_replay.mp4` | 5.8 s | Dead letter queue: two Replay clicks, rows clear, toast confirms | What could go wrong |
| C05 close | `C05_dead_letter_replay_close.mp4` | 5.8 s | Same moment, 1.5x zoom on the error column and Replay buttons | What could go wrong |
| K02 | `K02_flow.mp4` | 8.0 s | Card: receive and save, deliver, retry, reconcile, explain | How it works |
| C06 | `C06_slack_explainer.mp4` | 10.5 s | Mock Slack channel: Claude's incident notes (what happened, likely cause, suggested fix), scrolled from first to last | How it works |
| P02 | `P02_why_emails_failed.mp4` | 9.4 s | Terminal replay: "Why did the welcome emails fail last night?" typed, the plain-English answer from the event log appears | How I built it |
| C07 | `C07_email_check.mp4` | 10.5 s | Email check: SPF pass, DKIM missing in red with the exact record to add, DMARC pass, bounces | How it works |
| C08 | `C08_buyer_list.mp4` | 7.4 s | Buyer list sheet view: three new purchases arrive at the top with a green highlight | What this means for your business |
| K03 | `K03_safeguards.mp4` | 7.0 s | Card: saved before anything else, no duplicates, Claude explains but never changes settings | What could go wrong |
| K04 | `K04_offer.mp4` | 6.9 s | Card: what a version for your tools includes, set up in a week, running cost labelled as an estimate | What this means for your business |

Notes:

- The chaos run behind C01 to C05 used 20% failures, 5% silent drops and a 9 second email outage, so that some deliveries run out of retries and the dead letter queue has something to show.
- P02's answer is the real output of `POST /api/ask` for that run, in demo mode (recorded answer template filled with the numbers from the event log).
- On screen: first names, order numbers and masked emails on the reserved example.com domain only. No keys, tokens or personal paths.
