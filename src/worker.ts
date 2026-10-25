import type { Ctx } from './context.js';
import type { DeliveryRow } from './db.js';
import type { SourceEvent } from './types.js';
import { idempotencyKey } from './destinations.js';

// Exponential backoff with jitter: base, 2x base, 4x base ... capped at max.
export function backoffMs(attempt: number, baseMs: number, maxMs: number, random = Math.random): number {
  const raw = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.round(raw * (0.8 + 0.4 * random()));
}

function seconds(ms: number): string {
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60_000)} min`;
}

export class DeliveryWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private inFlight = new Set<Promise<void>>();

  constructor(private ctx: Ctx) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.ctx.config.workerPollMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled([...this.inFlight]);
  }

  // One polling round: claim what is due and send it. Exposed for tests.
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const { config, db } = this.ctx;
      const due = db.claimDue(20, config.requestTimeoutMs * 3);
      for (const delivery of due) {
        const p = this.process(delivery).finally(() => this.inFlight.delete(p));
        this.inFlight.add(p);
      }
    } finally {
      this.running = false;
    }
  }

  private async process(delivery: DeliveryRow): Promise<void> {
    const { config, db, incidents } = this.ctx;
    const destination = this.ctx.destinationByName.get(delivery.destination);
    const row = db.getEvent(delivery.event_id);
    if (!destination || !row) {
      db.markFailed(delivery.id, delivery.attempts, `unknown destination or event`, 'dead', Date.now());
      return;
    }
    const event = JSON.parse(row.payload) as SourceEvent;
    const attempt = delivery.attempts + 1;
    const key = idempotencyKey(row.source, row.external_id, destination.name);
    const result = await destination.send(event, key, config.requestTimeoutMs);

    if (result.ok) {
      db.markDelivered(delivery.id, attempt);
      db.addTimeline(row.id, 'delivered', `Delivered to ${destination.label} on attempt ${attempt}`, delivery.id);
      this.ctx.buyerSync.schedule();
      return;
    }

    const giveUp = !result.retryable || attempt >= config.maxAttempts;
    if (giveUp) {
      db.markFailed(delivery.id, attempt, result.error, 'dead', Date.now());
      const why = result.retryable ? `after ${attempt} attempts` : 'because the error cannot be fixed by retrying';
      db.addTimeline(row.id, 'dead_letter', `${destination.label}: ${result.error}. Moved to the dead letter queue ${why}. A person can replay it.`, delivery.id, result.error);
    } else {
      const wait = backoffMs(attempt, config.backoffBaseMs, config.backoffMaxMs);
      db.markFailed(delivery.id, attempt, result.error, 'retrying', Date.now() + wait);
      db.addTimeline(row.id, 'attempt_failed', `${destination.label}: attempt ${attempt} failed (${result.error}). Next try in ${seconds(wait)}`, delivery.id, result.error);
    }
    incidents.recordFailure({ destination: destination.name, errorClass: result.errorClass, error: result.error, eventId: row.id, deadLetter: giveUp });
  }

  // Waits until nothing is pending or retrying. Used by tests and the chaos script.
  async drain(timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await this.tick();
      await Promise.allSettled([...this.inFlight]);
      const open = this.ctx.db.sql.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE status IN ('pending', 'retrying')").get() as { n: number };
      if (open.n === 0) return;
      await new Promise((r) => setTimeout(r, Math.min(100, this.ctx.config.workerPollMs)));
    }
    throw new Error('worker did not drain in time');
  }
}

// One-click replay from the dashboard. Safe for delivered events too: the destination
// sees the same Idempotency-Key and ignores the repeat.
export function replayDelivery(ctx: Ctx, deliveryId: string, who = 'a person from the dashboard'): boolean {
  const delivery = ctx.db.getDelivery(deliveryId);
  if (!delivery) return false;
  ctx.db.requeue(delivery.id);
  const label = ctx.destinationByName.get(delivery.destination)?.label ?? delivery.destination;
  ctx.db.addTimeline(delivery.event_id, 'replayed', `Replay to ${label} requested by ${who}`, delivery.id);
  return true;
}

export function replayEvent(ctx: Ctx, eventId: string, who = 'a person from the dashboard'): boolean {
  const deliveries = ctx.db.deliveriesForEvent(eventId);
  if (deliveries.length === 0) return false;
  for (const d of deliveries) replayDelivery(ctx, d.id, who);
  return true;
}
