import type { Ctx } from './context.js';
import type { SourceEvent } from './types.js';
import { destinationsFor } from './destinations.js';
import { maskBuyer } from './mask.js';

export interface SilentMiss {
  kind: 'missed_webhook' | 'destination_dropped';
  eventId: string;
  destination: string | null;
  orderId: string;
  firstName: string;
}

export interface ReconcileResult {
  runId: number;
  checked: number;
  misses: SilentMiss[];
  skippedInFlight: number;
}

let running: Promise<ReconcileResult> | null = null;

// Asks every source for recent purchases and checks two things for each one:
// 1. Did we receive the webhook at all? If not, save it now and deliver it.
// 2. For every destination we marked "delivered", did the tool really act on it? If not, re-queue it.
// Deliveries still pending or retrying are left alone (the worker owns them), and dead letters
// stay where they are because they are already waiting for a person.
export function reconcile(ctx: Ctx): Promise<ReconcileResult> {
  if (!running) running = run(ctx).finally(() => (running = null));
  return running;
}

async function run(ctx: Ctx): Promise<ReconcileResult> {
  const { db, config } = ctx;
  const startedAt = Date.now();
  const runId = Number(db.sql.prepare('INSERT INTO reconciliation_runs (started_at) VALUES (?)').run(startedAt).lastInsertRowid);
  const misses: SilentMiss[] = [];
  let checked = 0;
  let skippedInFlight = 0;
  try {
    const since = startedAt - config.reconcileLookbackMinutes * 60_000;
    const settledBefore = startedAt - config.reconcileGraceSeconds * 1000;
    for (const source of ctx.sources.values()) {
      const purchases = await source.recentPurchases(since);
      for (const purchase of purchases) {
        if (purchase.created_at > settledBefore) continue; // too new, the webhook may still be on its way
        checked++;
        const existing = db.findEvent(source.name, purchase.id);
        if (!existing) {
          const row = db.insertEvent({
            source: source.name,
            externalId: purchase.id,
            type: purchase.type,
            payload: purchase,
            origin: 'reconciliation',
            destinations: destinationsFor(ctx.destinations, purchase.type),
          });
          if (row) {
            db.addTimeline(row.id, 'silent_miss', `The webhook for ${maskBuyer(purchase)} never arrived. Reconciliation found it in the ${source.label} and queued it for delivery.`);
            misses.push(missOf('missed_webhook', row.id, null, purchase));
          }
          continue;
        }
        const event = JSON.parse(existing.payload) as SourceEvent;
        for (const delivery of db.deliveriesForEvent(existing.id)) {
          if (delivery.status !== 'delivered') {
            skippedInFlight++;
            continue;
          }
          const destination = ctx.destinationByName.get(delivery.destination);
          if (!destination?.verify) continue;
          if (await destination.verify(event)) continue;
          db.requeue(delivery.id);
          db.addTimeline(existing.id, 'silent_miss', `${destination.label} said "ok" but has no record of ${maskBuyer(event)}. Reconciliation queued it again.`, delivery.id);
          misses.push(missOf('destination_dropped', existing.id, destination.name, event));
        }
      }
    }
    const insert = db.sql.prepare('INSERT INTO silent_misses (run_id, at, kind, event_id, destination, order_id, first_name) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const m of misses) insert.run(runId, Date.now(), m.kind, m.eventId, m.destination, m.orderId, m.firstName);
    db.sql.prepare('UPDATE reconciliation_runs SET finished_at = ?, checked = ?, misses = ? WHERE id = ?').run(Date.now(), checked, misses.length, runId);
    if (misses.length > 0) ctx.incidents.recordSilentMisses(misses);
    return { runId, checked, misses, skippedInFlight };
  } catch (err) {
    db.sql.prepare('UPDATE reconciliation_runs SET finished_at = ?, checked = ?, error = ? WHERE id = ?').run(Date.now(), checked, (err as Error).message, runId);
    throw err;
  }
}

function missOf(kind: SilentMiss['kind'], eventId: string, destination: string | null, e: SourceEvent): SilentMiss {
  return { kind, eventId, destination, orderId: e.data.order_id, firstName: e.data.buyer.first_name };
}

export function startReconcileSchedule(ctx: Ctx): () => void {
  const timer = setInterval(() => {
    reconcile(ctx).catch((err) => console.error('reconciliation failed:', (err as Error).message));
  }, ctx.config.reconcileIntervalMinutes * 60_000);
  return () => clearInterval(timer);
}
