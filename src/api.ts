import { Hono } from 'hono';
import type { Ctx } from './context.js';
import type { SourceEvent } from './types.js';
import { maskEmail, maskedEventSummary } from './mask.js';
import { replayDelivery, replayEvent } from './worker.js';
import { reconcile } from './reconcile.js';
import { ask } from './incidents.js';
import { buildBuyerList } from './buyers.js';
import { runChaos, verifyOutcome, emitPurchases, ChaosLog, type ChaosOptions } from './mocks/runner.js';
import { demoBuyers } from './mocks/buyers.js';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// JSON API for the dashboard. Buyer data leaves here masked: first name, order number, masked email.
export function apiRoutes(ctx: Ctx, chaosLog: ChaosLog): Hono {
  const app = new Hono();
  const { db } = ctx;
  const one = (sql: string, ...args: (string | number)[]) => (db.sql.prepare(sql).get(...args) as { n: number }).n;

  app.get('/stats', (c) => {
    const today = startOfToday();
    return c.json({
      eventsToday: one('SELECT COUNT(*) AS n FROM events WHERE received_at >= ?', today),
      delivered: one(`SELECT COUNT(*) AS n FROM events e WHERE e.received_at >= ? AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.event_id = e.id AND d.status != 'delivered')`, today),
      retrying: one(`SELECT COUNT(DISTINCT event_id) AS n FROM deliveries WHERE status = 'retrying' OR (status = 'pending' AND attempts > 0)`),
      inProgress: one(`SELECT COUNT(DISTINCT event_id) AS n FROM deliveries WHERE status IN ('pending', 'retrying')`),
      deadLetter: one(`SELECT COUNT(*) AS n FROM deliveries WHERE status = 'dead'`),
      silentMisses: one('SELECT COUNT(*) AS n FROM silent_misses WHERE at >= ?', today),
      rejected: one('SELECT COUNT(*) AS n FROM rejected_webhooks WHERE at >= ?', today),
      failedAttempts: one(`SELECT COUNT(*) AS n FROM timeline WHERE kind = 'attempt_failed' AND at >= ?`, today),
      lastReconciliation: db.sql.prepare('SELECT * FROM reconciliation_runs ORDER BY id DESC LIMIT 1').get() ?? null,
    });
  });

  app.get('/events', (c) => {
    const limit = Math.min(200, Number(c.req.query('limit') ?? 60));
    const rows = db.sql.prepare('SELECT * FROM events ORDER BY received_at DESC LIMIT ?').all(limit) as { id: string; payload: string; origin: string; received_at: number }[];
    return c.json(
      rows.map((r) => {
        const e = JSON.parse(r.payload) as SourceEvent;
        return {
          id: r.id,
          origin: r.origin,
          receivedAt: r.received_at,
          ...maskedEventSummary(e),
          deliveries: db.deliveriesForEvent(r.id).map((d) => ({ id: d.id, destination: d.destination, status: d.status, attempts: d.attempts, lastError: d.last_error })),
        };
      }),
    );
  });

  app.get('/events/:id', (c) => {
    const row = db.getEvent(c.req.param('id'));
    if (!row) return c.json({ error: 'not found' }, 404);
    const e = JSON.parse(row.payload) as SourceEvent;
    return c.json({
      id: row.id,
      origin: row.origin,
      receivedAt: row.received_at,
      ...maskedEventSummary(e),
      deliveries: db.deliveriesForEvent(row.id),
      timeline: db.timeline(row.id).map(({ at, kind, message }) => ({ at, kind, message })),
    });
  });

  app.post('/events/:id/replay', (c) => (replayEvent(ctx, c.req.param('id')) ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404)));
  app.post('/deliveries/:id/replay', (c) => (replayDelivery(ctx, c.req.param('id')) ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404)));

  app.get('/dead-letter', (c) => {
    const rows = db.sql
      .prepare(`SELECT d.*, e.payload FROM deliveries d JOIN events e ON e.id = d.event_id WHERE d.status = 'dead' ORDER BY d.next_attempt_at DESC`)
      .all() as unknown as { id: string; event_id: string; destination: string; attempts: number; last_error: string; next_attempt_at: number; payload: string }[];
    return c.json(
      rows.map((r) => ({
        id: r.id,
        eventId: r.event_id,
        destination: ctx.destinationByName.get(r.destination)?.label ?? r.destination,
        attempts: r.attempts,
        lastError: r.last_error,
        failedAt: r.next_attempt_at,
        ...maskedEventSummary(JSON.parse(r.payload) as SourceEvent),
      })),
    );
  });

  app.post('/dead-letter/replay-all', (c) => {
    const ids = db.sql.prepare(`SELECT id FROM deliveries WHERE status = 'dead'`).all() as { id: string }[];
    for (const { id } of ids) replayDelivery(ctx, id);
    return c.json({ ok: true, replayed: ids.length });
  });

  app.get('/reconciliation', (c) => {
    const runs = db.sql.prepare('SELECT * FROM reconciliation_runs ORDER BY id DESC LIMIT 10').all();
    const misses = db.sql.prepare('SELECT * FROM silent_misses ORDER BY id DESC LIMIT 50').all() as { kind: string; destination: string | null; order_id: string; first_name: string; at: number; event_id: string; run_id: number }[];
    return c.json({
      intervalMinutes: ctx.config.reconcileIntervalMinutes,
      runs,
      misses: misses.map((m) => {
        const deliveries = db.deliveriesForEvent(m.event_id).filter((d) => !m.destination || d.destination === m.destination);
        const now = deliveries.every((d) => d.status === 'delivered') ? 'delivered' : deliveries.some((d) => d.status === 'dead') ? 'dead' : 'replaying';
        return { ...m, now, destination: m.destination ? ctx.destinationByName.get(m.destination)?.label ?? m.destination : null };
      }),
    });
  });

  app.post('/reconciliation/run', async (c) => {
    try {
      const result = await reconcile(ctx);
      return c.json(result);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
  });

  app.get('/slack', (c) => c.json(db.sql.prepare('SELECT * FROM slack_messages ORDER BY id DESC LIMIT 50').all()));

  app.get('/email-check', async (c) => c.json(await ctx.emailCheck()));

  app.get('/buyers', (c) => {
    const rows = buildBuyerList(ctx).map(({ last_name, email, ...rest }) => ({ ...rest, last_initial: last_name.slice(0, 1), email: maskEmail(email) }));
    return c.json({ adapter: ctx.buyerSync.adapter.name, lastSyncedAt: ctx.buyerSync.lastSyncedAt, lastError: ctx.buyerSync.lastError, rows });
  });
  app.post('/buyers/sync', async (c) => {
    await ctx.buyerSync.syncNow();
    return c.json({ ok: ctx.buyerSync.lastError === null, lastSyncedAt: ctx.buyerSync.lastSyncedAt, error: ctx.buyerSync.lastError });
  });

  app.post('/ask', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { question?: string };
    const question = (body.question ?? '').slice(0, 500);
    if (!question) return c.json({ error: 'question is required' }, 400);
    return c.json(await ask(ctx, question));
  });

  app.get('/rejected', (c) => c.json(db.sql.prepare('SELECT id, source, at, reason FROM rejected_webhooks ORDER BY id DESC LIMIT 50').all()));

  // Demo-only controls for the chaos test.
  let chaosRunning = false;
  app.post('/chaos/start', async (c) => {
    if (!ctx.mocks) return c.json({ error: 'chaos runs only in demo mode' }, 400);
    if (chaosRunning) return c.json({ error: 'a chaos run is already in progress' }, 409);
    const b = (await c.req.json().catch(() => ({}))) as Partial<ChaosOptions> & { outageDestination?: string; outageSeconds?: number };
    const opts: ChaosOptions = {
      buyers: Math.min(50, b.buyers ?? 50),
      failRate: b.failRate ?? 0.2,
      dropRate: b.dropRate ?? 0.05,
      seed: b.seed ?? 7,
      intervalMs: b.intervalMs ?? 120,
      tags: b.tags ?? 0,
      outage: b.outageDestination ? { destination: b.outageDestination, seconds: b.outageSeconds ?? 10 } : undefined,
    };
    chaosRunning = true;
    chaosLog.clear();
    runChaos(ctx, opts, chaosLog)
      .catch((err) => chaosLog.add(`chaos run failed: ${(err as Error).message}`, 'warn'))
      .finally(() => (chaosRunning = false));
    return c.json({ ok: true, opts });
  });
  app.post('/chaos/stop', (c) => {
    ctx.mocks?.chaos.off();
    chaosLog.add('Chaos switched off. All tools behave normally again.', 'ok');
    return c.json({ ok: true });
  });
  app.get('/chaos/log', (c) => c.json({ running: chaosRunning, lines: chaosLog.after(Number(c.req.query('after') ?? 0)) }));
  app.post('/demo/reset', (c) => {
    if (!ctx.mocks) return c.json({ error: 'demo mode only' }, 400);
    if (chaosRunning) return c.json({ error: 'a chaos run is in progress' }, 409);
    ctx.mocks.chaos.off();
    db.reset();
    ctx.mocks.state.reset(demoBuyers(50));
    ctx.incidents.reset();
    chaosLog.clear();
    rmSync(join(ctx.config.dataDir, 'buyers.csv'), { force: true });
    return c.json({ ok: true, buyers: 50 });
  });
  app.post('/demo/purchases', async (c) => {
    if (!ctx.mocks) return c.json({ error: 'demo mode only' }, 400);
    const b = (await c.req.json().catch(() => ({}))) as { count?: number; intervalMs?: number };
    const sent = await emitPurchases(ctx, Math.min(10, b.count ?? 3), b.intervalMs ?? 1200);
    return c.json({ ok: true, sent });
  });
  app.get('/chaos/verify', (c) => (ctx.mocks ? c.json(verifyOutcome(ctx)) : c.json({ error: 'demo mode only' }, 400)));

  return app;
}
