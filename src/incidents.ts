import type { Ctx } from './context.js';
import type { ErrorClass } from './destinations.js';
import type { SilentMiss } from './reconcile.js';
import type { SourceEvent } from './types.js';
import { explainIncident, answerQuestion, type Facts } from './explainer.js';
import { maskBuyer } from './mask.js';
import { postSlack } from './slack.js';

interface Failure {
  at: number;
  errorClass: ErrorClass;
  error: string;
  eventId: string;
}

export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// Watches failures as they happen. When one tool keeps failing (or something lands in the
// dead letter queue, or reconciliation catches silent misses) it opens one incident, asks
// Claude to explain it, and posts the explanation to Slack. At most one incident per
// pattern per window, so a bad hour does not flood the channel.
export class IncidentDetector {
  private failures = new Map<string, Failure[]>();
  private lastOpened = new Map<string, number>();
  private pending = new Set<Promise<void>>();

  constructor(private ctx: Ctx) {}

  private get windowMs(): number {
    return this.ctx.config.incidentWindowMinutes * 60_000;
  }

  recordFailure(input: { destination: string; errorClass: ErrorClass; error: string; eventId: string; deadLetter: boolean }): void {
    const now = Date.now();
    const list = (this.failures.get(input.destination) ?? []).filter((f) => now - f.at < this.windowMs);
    list.push({ at: now, errorClass: input.errorClass, error: input.error, eventId: input.eventId });
    this.failures.set(input.destination, list);
    if (input.deadLetter) this.open(`${input.destination}:dead_letter`, input.destination, 'dead_letter');
    if (list.length >= this.ctx.config.incidentFailureThreshold) this.open(`${input.destination}:failures`, input.destination, null);
  }

  recordSilentMisses(misses: SilentMiss[]): void {
    const now = Date.now();
    const key = `reconciliation:${now}`;
    const missedWebhooks = misses.filter((m) => m.kind === 'missed_webhook');
    const dropped = misses.filter((m) => m.kind === 'destination_dropped');
    const facts: Facts = {
      miss_count: misses.length,
      missed_webhooks: missedWebhooks.length,
      dropped: dropped.length,
      dropped_by: dropped.length ? [...new Set(dropped.map((m) => this.label(m.destination!)))] : 'none',
      affected: misses.map((m) => `${m.firstName} (order ${m.orderId})`),
      time: clock(now),
      interval_minutes: this.ctx.config.reconcileIntervalMinutes,
    };
    this.track(this.explainAndPost(key, 'reconciliation', 'silent_miss', facts, misses.length));
  }

  reset(): void {
    this.failures.clear();
    this.lastOpened.clear();
  }

  // Resolves when every explanation that has started has been posted. Used by tests.
  async settle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  private label(destination: string): string {
    return this.ctx.destinationByName.get(destination)?.label ?? destination;
  }

  private track(p: Promise<void>): void {
    const wrapped = p.catch((err) => console.error('incident explainer failed:', (err as Error).message)).finally(() => this.pending.delete(wrapped));
    this.pending.add(wrapped);
  }

  // Waits a short while before explaining, so the incident covers the whole burst
  // rather than the first few failures.
  private open(key: string, destination: string, kind: string | null): void {
    const now = Date.now();
    const last = this.lastOpened.get(key);
    if (last !== undefined && now - last < this.windowMs) return;
    this.lastOpened.set(key, now);
    this.track(
      new Promise<void>((resolve) => setTimeout(resolve, this.ctx.config.incidentDelaySeconds * 1000)).then(() => {
        const list = (this.failures.get(destination) ?? []).filter((f) => Date.now() - f.at < this.windowMs);
        if (list.length === 0) return;
        return this.explainAndPost(key, destination, kind ?? dominant(list), this.failureFacts(destination, list), list.length);
      }),
    );
  }

  private failureFacts(destination: string, list: Failure[]): Facts {
    const counts = new Map<string, number>();
    for (const f of list) counts.set(f.error, (counts.get(f.error) ?? 0) + 1);
    const errors = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const affected = [...new Set(list.map((f) => f.eventId))].slice(0, 5).map((id) => {
      const row = this.ctx.db.getEvent(id);
      return row ? maskBuyer(JSON.parse(row.payload) as SourceEvent) : 'unknown order';
    });
    const dead = this.ctx.db.sql.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE destination = ? AND status = 'dead'").get(destination) as { n: number };
    return {
      destination: this.label(destination),
      failures: list.length,
      window_minutes: this.ctx.config.incidentWindowMinutes,
      first_time: clock(list[0].at),
      last_time: clock(list[list.length - 1].at),
      top_error: errors[0][0],
      errors: errors.map(([e, n]) => `${e} x${n}`),
      affected,
      dead_count: dead.n,
      max_attempts: this.ctx.config.maxAttempts,
    };
  }

  private async explainAndPost(key: string, destination: string, kind: string, facts: Facts, failures: number): Promise<void> {
    const explanation = await explainIncident(this.ctx.config, kind, facts);
    this.ctx.db.sql
      .prepare('INSERT INTO incidents (pattern, destination, created_at, failures, summary, likely_cause, suggested_fix, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(key, destination, Date.now(), failures, explanation.summary, explanation.likely_cause, explanation.suggested_fix, explanation.model);
    const title = kind === 'silent_miss' ? 'Reconciliation caught silent misses' : kind === 'dead_letter' ? `${this.label(destination)}: delivery moved to the dead letter queue` : `${this.label(destination)}: repeated failures`;
    const text = [
      `*What happened*\n${explanation.summary}`,
      `*Likely cause*\n${explanation.likely_cause}`,
      `*Suggested fix*\n${explanation.suggested_fix}`,
      `_Explained by Claude${explanation.model.startsWith('recorded') ? ' (recorded answer, demo mode)' : ''}. Claude can read the logs but cannot change settings or replay events._`,
    ].join('\n\n');
    await postSlack(this.ctx, title, text);
  }
}

function dominant(list: Failure[]): ErrorClass {
  const counts = new Map<ErrorClass, number>();
  for (const f of list) counts.set(f.errorClass, (counts.get(f.errorClass) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

const TOPICS: { topic: string; destination: string; words: RegExp }[] = [
  { topic: 'email', destination: 'email', words: /email|welcome|inbox|mail/i },
  { topic: 'membership', destination: 'membership', words: /access|login|log in|membership|account/i },
  { topic: 'n8n', destination: 'n8n', words: /n8n|workflow/i },
];

// "Why did the welcome emails fail last night?" Gathers masked facts for the last 24 hours
// about the tool the question is about, and lets Claude answer from those facts only.
export async function ask(ctx: Ctx, question: string, now = Date.now()): Promise<{ answer: string; model: string; facts: Facts }> {
  const match = TOPICS.find((t) => t.words.test(question)) ?? TOPICS[0];
  const since = now - 24 * 60 * 60_000;
  const label = ctx.destinationByName.get(match.destination)?.label ?? match.destination;
  const failedRows = ctx.db.sql
    .prepare(
      `SELECT t.at, t.detail, t.event_id FROM timeline t JOIN deliveries d ON d.id = t.delivery_id
       WHERE d.destination = ? AND t.kind IN ('attempt_failed', 'dead_letter') AND t.at >= ? ORDER BY t.at`,
    )
    .all(match.destination, since) as { at: number; detail: string | null; event_id: string }[];
  const errorCounts = new Map<string, number>();
  for (const r of failedRows) {
    const err = r.detail ?? 'other error';
    errorCounts.set(err, (errorCounts.get(err) ?? 0) + 1);
  }
  const statusCount = (status: string) =>
    (ctx.db.sql
      .prepare(
        `SELECT COUNT(DISTINCT d.id) AS n FROM deliveries d JOIN events e ON e.id = d.event_id
         WHERE d.destination = ? AND d.status = ? AND e.received_at >= ? AND d.attempts > ?`,
      )
      .get(match.destination, status, since, status === 'delivered' ? 1 : 0) as { n: number }).n;
  const affectedIds = [...new Set(failedRows.map((r) => r.event_id))];
  const deadRows = ctx.db.sql
    .prepare("SELECT d.event_id FROM deliveries d JOIN events e ON e.id = d.event_id WHERE d.destination = ? AND d.status = 'dead' AND e.received_at >= ?")
    .all(match.destination, since) as { event_id: string }[];
  const masked = (id: string) => {
    const row = ctx.db.getEvent(id);
    return row ? maskBuyer(JSON.parse(row.payload) as SourceEvent) : 'unknown order';
  };
  const misses = ctx.db.sql.prepare('SELECT COUNT(*) AS n FROM silent_misses WHERE destination = ? AND at >= ?').get(match.destination, since) as { n: number };
  const facts: Facts = {
    destination: label,
    period: 'the last 24 hours',
    failed_attempts: failedRows.length,
    customers_affected: affectedIds.length,
    first_failure: failedRows.length ? clock(failedRows[0].at) : '',
    last_failure: failedRows.length ? clock(failedRows[failedRows.length - 1].at) : '',
    errors: [...errorCounts.entries()].sort((a, b) => b[1] - a[1]).map(([e, n]) => `${e} x${n}`),
    top_error: [...errorCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '',
    delivered_after_retry: statusCount('delivered'),
    still_in_dead_letter: deadRows.length,
    dead_letter_orders: deadRows.slice(0, 5).map((r) => masked(r.event_id)),
    silent_misses_caught: misses.n,
    max_attempts: ctx.config.maxAttempts,
    email_auth_note: '',
  };
  if (match.topic === 'email') {
    const report = await ctx.emailCheck();
    const failing = report.checks.filter((c) => c.status === 'fail' && c.name !== 'Bounces').map((c) => c.name);
    if (failing.length) facts.email_auth_note = `Separately, the email check shows ${failing.join(' and ')} ${failing.length === 1 ? 'is' : 'are'} missing on ${report.domain}, which can push welcome emails into spam even when sending works.`;
  }
  const { answer, model } = await answerQuestion(ctx.config, question, match.topic, facts);
  return { answer, model, facts };
}
