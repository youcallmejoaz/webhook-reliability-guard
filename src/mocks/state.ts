import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { Buyer, SourceEvent, SourceEventType } from '../types.js';

// Persistent state for the mock store, membership site, email sender and n8n.
// It lives in its own SQLite file so the guard's database never mixes with "the outside world".
// The membership site and email sender are deliberately naive: they create a new row for every
// request they accept. Only the Idempotency-Key header protects them from duplicates, which is
// exactly what the tests check.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS buyers (id TEXT PRIMARY KEY, first_name TEXT, last_name TEXT, email TEXT, position INTEGER);
CREATE TABLE IF NOT EXISTS store_events (id TEXT PRIMARY KEY, type TEXT, order_id TEXT, buyer_id TEXT, created_at INTEGER, body TEXT, webhook TEXT);
CREATE TABLE IF NOT EXISTS accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, buyer_id TEXT, order_id TEXT, first_name TEXT, product TEXT, status TEXT, tags TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS emails (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT, buyer_id TEXT, to_addr TEXT, first_name TEXT, template TEXT, status TEXT, at INTEGER);
CREATE TABLE IF NOT EXISTS n8n_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT, order_id TEXT, at INTEGER);
CREATE TABLE IF NOT EXISTS idempotency (destination TEXT, key TEXT, at INTEGER, PRIMARY KEY (destination, key));
CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER);
`;

export interface AccountRow { id: number; buyer_id: string; order_id: string; first_name: string; product: string; status: string; tags: string; created_at: number }
export interface EmailRow { id: number; order_id: string; buyer_id: string; to_addr: string; first_name: string; template: string; status: string; at: number }

export class MockState {
  readonly sql: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.sql = new DatabaseSync(path);
    this.sql.exec('PRAGMA journal_mode = WAL;');
    this.sql.exec(SCHEMA);
  }

  close(): void {
    this.sql.close();
  }

  reset(buyers: Buyer[]): void {
    for (const t of ['buyers', 'store_events', 'accounts', 'emails', 'n8n_calls', 'idempotency', 'counters']) this.sql.exec(`DELETE FROM ${t}`);
    const insert = this.sql.prepare('INSERT INTO buyers (id, first_name, last_name, email, position) VALUES (?, ?, ?, ?, ?)');
    buyers.forEach((b, i) => insert.run(b.id, b.first_name, b.last_name, b.email, i));
  }

  buyers(): Buyer[] {
    return this.sql.prepare('SELECT id, first_name, last_name, email FROM buyers ORDER BY position').all() as unknown as Buyer[];
  }

  buyer(id: string): Buyer | undefined {
    return this.sql.prepare('SELECT id, first_name, last_name, email FROM buyers WHERE id = ?').get(id) as Buyer | undefined;
  }

  private next(name: string, start: number): number {
    const row = this.sql.prepare('SELECT value FROM counters WHERE name = ?').get(name) as { value: number } | undefined;
    const value = row ? row.value + 1 : start;
    this.sql.prepare('INSERT INTO counters (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value').run(name, value);
    return value;
  }

  // The store records the event first (it is the source of truth), then tries to send the webhook.
  createStoreEvent(type: SourceEventType, buyer: Buyer, extra: { product?: string; amount?: number; tag?: string; orderId?: string } = {}, now = Date.now()): SourceEvent {
    const orderId = extra.orderId ?? String(this.next('order', 10401));
    // Deterministic ids keep chaos runs repeatable after a seed. A real store uses its own ids.
    const seq = this.next('event', 1);
    const event: SourceEvent = {
      id: `evt_${createHash('sha256').update(`${seq}|${type}|${orderId}`).digest('hex').slice(0, 16)}`,
      type,
      created_at: now,
      data: {
        order_id: orderId,
        buyer,
        ...(extra.product ? { product: extra.product } : {}),
        ...(extra.amount !== undefined ? { amount: extra.amount, currency: 'USD' } : {}),
        ...(extra.tag ? { tag: extra.tag } : {}),
      },
    };
    this.sql
      .prepare("INSERT INTO store_events (id, type, order_id, buyer_id, created_at, body, webhook) VALUES (?, ?, ?, ?, ?, ?, 'pending')")
      .run(event.id, type, orderId, buyer.id, now, JSON.stringify(event));
    return event;
  }

  setWebhookStatus(eventId: string, status: 'sent' | 'lost' | 'failed'): void {
    this.sql.prepare('UPDATE store_events SET webhook = ? WHERE id = ?').run(status, eventId);
  }

  purchasesSince(since: number): SourceEvent[] {
    const rows = this.sql.prepare("SELECT body FROM store_events WHERE type = 'purchase.created' AND created_at >= ? ORDER BY created_at").all(since) as { body: string }[];
    return rows.map((r) => JSON.parse(r.body) as SourceEvent);
  }

  // Returns true when the key was new (so the request should be processed).
  claimKey(destination: string, key: string): boolean {
    const r = this.sql.prepare('INSERT OR IGNORE INTO idempotency (destination, key, at) VALUES (?, ?, ?)').run(destination, key, Date.now());
    return r.changes === 1;
  }

  applyMembership(event: SourceEvent): void {
    const { buyer, order_id, product, tag } = event.data;
    if (event.type === 'purchase.created') {
      this.sql
        .prepare("INSERT INTO accounts (buyer_id, order_id, first_name, product, status, tags, created_at) VALUES (?, ?, ?, ?, 'active', '', ?)")
        .run(buyer.id, order_id, buyer.first_name, product ?? '', Date.now());
    } else if (event.type === 'tag.applied' && tag) {
      const rows = this.sql.prepare('SELECT id, tags FROM accounts WHERE buyer_id = ?').all(buyer.id) as { id: number; tags: string }[];
      for (const row of rows) {
        const tags = new Set(row.tags.split(',').filter(Boolean));
        tags.add(tag);
        this.sql.prepare('UPDATE accounts SET tags = ? WHERE id = ?').run([...tags].join(','), row.id);
      }
    } else if (event.type === 'subscription.cancelled') {
      this.sql.prepare("UPDATE accounts SET status = 'cancelled' WHERE order_id = ?").run(order_id);
    }
  }

  sendEmail(event: SourceEvent, bounced: boolean): void {
    const { buyer, order_id } = event.data;
    this.sql
      .prepare("INSERT INTO emails (order_id, buyer_id, to_addr, first_name, template, status, at) VALUES (?, ?, ?, ?, 'welcome', ?, ?)")
      .run(order_id, buyer.id, buyer.email, buyer.first_name, bounced ? 'bounced' : 'sent', Date.now());
  }

  recordN8n(event: SourceEvent): void {
    this.sql.prepare('INSERT INTO n8n_calls (event_type, order_id, at) VALUES (?, ?, ?)').run(event.type, event.data.order_id, Date.now());
  }

  accountsForOrder(orderId: string): AccountRow[] {
    return this.sql.prepare('SELECT * FROM accounts WHERE order_id = ?').all(orderId) as unknown as AccountRow[];
  }

  accounts(): AccountRow[] {
    return this.sql.prepare('SELECT * FROM accounts ORDER BY id').all() as unknown as AccountRow[];
  }

  welcomeEmailsForOrder(orderId: string): EmailRow[] {
    return this.sql.prepare("SELECT * FROM emails WHERE order_id = ? AND template = 'welcome'").all(orderId) as unknown as EmailRow[];
  }

  emails(since = 0): EmailRow[] {
    return this.sql.prepare('SELECT * FROM emails WHERE at >= ? ORDER BY id').all(since) as unknown as EmailRow[];
  }
}
