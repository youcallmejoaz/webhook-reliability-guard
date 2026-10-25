import { createSign } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { Ctx } from './context.js';
import type { SourceEvent } from './types.js';

// Keeps an always current buyer list: one row per order, with access status and tags.
// It is pushed through an adapter: a CSV file in demo mode, Google Sheets in production.

export interface BuyerRow {
  order_id: string;
  first_name: string;
  last_name: string;
  email: string;
  product: string;
  amount: string;
  purchased_at: string;
  status: 'active' | 'cancelled';
  access: 'granted' | 'pending';
  tags: string;
}

export const COLUMNS: (keyof BuyerRow)[] = ['order_id', 'first_name', 'last_name', 'email', 'product', 'amount', 'purchased_at', 'status', 'access', 'tags'];

export function buildBuyerList(ctx: Ctx): BuyerRow[] {
  const rows = ctx.db.sql.prepare('SELECT id, payload FROM events ORDER BY received_at').all() as { id: string; payload: string }[];
  const byOrder = new Map<string, BuyerRow>();
  const tagsByBuyer = new Map<string, Set<string>>();
  for (const { id, payload } of rows) {
    const e = JSON.parse(payload) as SourceEvent;
    if (e.type === 'purchase.created') {
      const membership = ctx.db.deliveriesForEvent(id).find((d) => d.destination === 'membership');
      byOrder.set(e.data.order_id, {
        order_id: e.data.order_id,
        first_name: e.data.buyer.first_name,
        last_name: e.data.buyer.last_name,
        email: e.data.buyer.email,
        product: e.data.product ?? '',
        amount: e.data.amount !== undefined ? `${e.data.amount.toFixed(2)} ${e.data.currency ?? ''}`.trim() : '',
        purchased_at: new Date(e.created_at).toISOString(),
        status: 'active',
        access: membership?.status === 'delivered' ? 'granted' : 'pending',
        tags: '',
      });
    } else if (e.type === 'tag.applied' && e.data.tag) {
      const set = tagsByBuyer.get(e.data.buyer.id) ?? new Set<string>();
      set.add(e.data.tag);
      tagsByBuyer.set(e.data.buyer.id, set);
    } else if (e.type === 'subscription.cancelled') {
      const row = byOrder.get(e.data.order_id);
      if (row) row.status = 'cancelled';
    }
  }
  const buyerIdByOrder = new Map(rows.map(({ payload }) => {
    const e = JSON.parse(payload) as SourceEvent;
    return [e.data.order_id, e.data.buyer.id] as const;
  }));
  const list = [...byOrder.values()];
  for (const row of list) row.tags = [...(tagsByBuyer.get(buyerIdByOrder.get(row.order_id) ?? '') ?? [])].join(', ');
  // Newest first, the way people read a sheet of recent buyers.
  return list.sort((a, b) => (a.purchased_at < b.purchased_at ? 1 : -1));
}

export interface SheetAdapter {
  name: string;
  write(rows: BuyerRow[]): Promise<void>;
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function csvAdapter(dataDir: string): SheetAdapter {
  return {
    name: 'CSV file',
    async write(rows) {
      mkdirSync(dataDir, { recursive: true });
      const body = [COLUMNS.join(','), ...rows.map((r) => COLUMNS.map((c) => csvCell(String(r[c]))).join(','))].join('\n') + '\n';
      const tmp = join(dataDir, 'buyers.csv.tmp');
      writeFileSync(tmp, body);
      renameSync(tmp, join(dataDir, 'buyers.csv'));
    },
  };
}

// Google Sheets through a service account. Share the sheet with the service account's
// address, then set SHEETS_ADAPTER=google, GOOGLE_SHEET_ID and GOOGLE_SERVICE_ACCOUNT_JSON.
// Not exercised in demo mode or tests.
export function googleSheetsAdapter(sheetId: string, serviceAccountJson: string, range = 'Buyers!A1'): SheetAdapter {
  const account = JSON.parse(serviceAccountJson) as { client_email: string; private_key: string };
  const b64 = (v: string | Buffer) => Buffer.from(v).toString('base64url');
  async function token(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const head = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claim = b64(JSON.stringify({ iss: account.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
    const signature = createSign('RSA-SHA256').update(`${head}.${claim}`).sign(account.private_key);
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claim}.${b64(signature)}` }),
    });
    if (!res.ok) throw new Error(`Google token request failed: HTTP ${res.status}`);
    return ((await res.json()) as { access_token: string }).access_token;
  }
  return {
    name: 'Google Sheets',
    async write(rows) {
      const values = [COLUMNS, ...rows.map((r) => COLUMNS.map((c) => String(r[c])))];
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
      const res = await fetch(url, { method: 'PUT', headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' }, body: JSON.stringify({ values }) });
      if (!res.ok) throw new Error(`Google Sheets update failed: HTTP ${res.status}`);
    },
  };
}

// Debounced sync: many deliveries in a burst cause one write.
export class BuyerSync {
  lastSyncedAt: number | null = null;
  lastError: string | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private ctx: Ctx, readonly adapter: SheetAdapter, private debounceMs = 500) {}

  schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.syncNow();
    }, this.debounceMs);
  }

  async syncNow(): Promise<void> {
    try {
      await this.adapter.write(buildBuyerList(this.ctx));
      this.lastSyncedAt = Date.now();
      this.lastError = null;
    } catch (err) {
      this.lastError = (err as Error).message;
      console.error('buyer list sync failed:', this.lastError);
    }
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
