import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export type DeliveryStatus = 'pending' | 'retrying' | 'delivered' | 'dead';

export interface EventRow {
  id: string;
  source: string;
  external_id: string;
  type: string;
  payload: string;
  origin: string;
  received_at: number;
}

export interface DeliveryRow {
  id: string;
  event_id: string;
  destination: string;
  status: DeliveryStatus;
  attempts: number;
  next_attempt_at: number;
  locked_until: number | null;
  last_error: string | null;
  delivered_at: number | null;
  created_at: number;
}

export interface TimelineRow {
  id: number;
  event_id: string;
  delivery_id: string | null;
  at: number;
  kind: string;
  message: string;
  detail: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  origin TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  UNIQUE (source, external_id)
);
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  destination TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  locked_until INTEGER,
  last_error TEXT,
  delivered_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (event_id, destination)
);
CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries (status, next_attempt_at);
CREATE TABLE IF NOT EXISTS timeline (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  delivery_id TEXT,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS timeline_event ON timeline (event_id, at);
CREATE INDEX IF NOT EXISTS timeline_at ON timeline (at);
CREATE TABLE IF NOT EXISTS rejected_webhooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  body_sha256 TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  checked INTEGER NOT NULL DEFAULT 0,
  misses INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE TABLE IF NOT EXISTS silent_misses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  event_id TEXT NOT NULL,
  destination TEXT,
  order_id TEXT NOT NULL,
  first_name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern TEXT NOT NULL,
  destination TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  failures INTEGER NOT NULL,
  summary TEXT NOT NULL,
  likely_cause TEXT NOT NULL,
  suggested_fix TEXT NOT NULL,
  model TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS slack_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  at INTEGER NOT NULL,
  title TEXT NOT NULL,
  text TEXT NOT NULL
);
`;

export class Db {
  readonly sql: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.sql = new DatabaseSync(path);
    this.sql.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
    this.sql.exec(SCHEMA);
  }

  close(): void {
    this.sql.close();
  }

  // Wipes every table. Used by the seed script and tests.
  reset(): void {
    for (const table of ['deliveries', 'events', 'timeline', 'rejected_webhooks', 'reconciliation_runs', 'silent_misses', 'incidents', 'slack_messages']) {
      this.sql.exec(`DELETE FROM ${table}`);
    }
  }

  transaction<T>(fn: () => T): T {
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.sql.exec('COMMIT');
      return result;
    } catch (err) {
      this.sql.exec('ROLLBACK');
      throw err;
    }
  }

  // Stores an event and one pending delivery per destination in a single transaction.
  // Returns null when the event was already stored (duplicate webhook).
  insertEvent(input: { source: string; externalId: string; type: string; payload: unknown; origin: string; destinations: string[]; now?: number }): EventRow | null {
    const now = input.now ?? Date.now();
    return this.transaction(() => {
      const existing = this.sql.prepare('SELECT id FROM events WHERE source = ? AND external_id = ?').get(input.source, input.externalId);
      if (existing) return null;
      const row: EventRow = {
        id: randomUUID(),
        source: input.source,
        external_id: input.externalId,
        type: input.type,
        payload: JSON.stringify(input.payload),
        origin: input.origin,
        received_at: now,
      };
      this.sql
        .prepare('INSERT INTO events (id, source, external_id, type, payload, origin, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(row.id, row.source, row.external_id, row.type, row.payload, row.origin, row.received_at);
      const insertDelivery = this.sql.prepare(
        "INSERT INTO deliveries (id, event_id, destination, status, attempts, next_attempt_at, created_at) VALUES (?, ?, ?, 'pending', 0, ?, ?)",
      );
      for (const destination of input.destinations) insertDelivery.run(randomUUID(), row.id, destination, now, now);
      return row;
    });
  }

  getEvent(id: string): EventRow | undefined {
    return this.sql.prepare('SELECT * FROM events WHERE id = ?').get(id) as EventRow | undefined;
  }

  findEvent(source: string, externalId: string): EventRow | undefined {
    return this.sql.prepare('SELECT * FROM events WHERE source = ? AND external_id = ?').get(source, externalId) as EventRow | undefined;
  }

  // Atomically claims due deliveries so two workers never send the same one at the same time.
  // This is the SQLite equivalent of SELECT ... FOR UPDATE SKIP LOCKED.
  claimDue(limit: number, lockMs: number, now = Date.now()): DeliveryRow[] {
    return this.sql
      .prepare(
        `UPDATE deliveries SET locked_until = ?
         WHERE id IN (
           SELECT id FROM deliveries
           WHERE status IN ('pending', 'retrying') AND next_attempt_at <= ?
             AND (locked_until IS NULL OR locked_until < ?)
           ORDER BY next_attempt_at LIMIT ?
         )
         RETURNING *`,
      )
      .all(now + lockMs, now, now, limit) as unknown as DeliveryRow[];
  }

  getDelivery(id: string): DeliveryRow | undefined {
    return this.sql.prepare('SELECT * FROM deliveries WHERE id = ?').get(id) as DeliveryRow | undefined;
  }

  deliveriesForEvent(eventId: string): DeliveryRow[] {
    return this.sql.prepare('SELECT * FROM deliveries WHERE event_id = ? ORDER BY destination').all(eventId) as unknown as DeliveryRow[];
  }

  markDelivered(id: string, attempts: number, now = Date.now()): void {
    this.sql
      .prepare("UPDATE deliveries SET status = 'delivered', attempts = ?, delivered_at = ?, locked_until = NULL, last_error = NULL WHERE id = ?")
      .run(attempts, now, id);
  }

  markFailed(id: string, attempts: number, error: string, status: 'retrying' | 'dead', nextAttemptAt: number): void {
    this.sql
      .prepare('UPDATE deliveries SET status = ?, attempts = ?, last_error = ?, next_attempt_at = ?, locked_until = NULL WHERE id = ?')
      .run(status, attempts, error, nextAttemptAt, id);
  }

  // Puts a delivery back in the queue with a fresh retry budget. Used by replay and reconciliation.
  requeue(id: string, now = Date.now()): void {
    this.sql
      .prepare("UPDATE deliveries SET status = 'pending', attempts = 0, next_attempt_at = ?, locked_until = NULL WHERE id = ?")
      .run(now, id);
  }

  addTimeline(eventId: string, kind: string, message: string, deliveryId: string | null = null, detail: string | null = null, now = Date.now()): void {
    this.sql.prepare('INSERT INTO timeline (event_id, delivery_id, at, kind, message, detail) VALUES (?, ?, ?, ?, ?, ?)').run(eventId, deliveryId, now, kind, message, detail);
  }

  timeline(eventId: string): TimelineRow[] {
    return this.sql.prepare('SELECT * FROM timeline WHERE event_id = ? ORDER BY at, id').all(eventId) as unknown as TimelineRow[];
  }
}
