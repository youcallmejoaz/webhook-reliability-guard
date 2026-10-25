import type { Ctx } from '../context.js';
import { idempotencyKey } from '../destinations.js';
import { seededShuffle } from './chaos.js';
import { PRODUCTS } from './buyers.js';
import { sendStoreWebhook } from './routes.js';

export interface ChaosOptions {
  buyers: number;
  failRate: number;
  dropRate: number;
  seed: number;
  intervalMs: number;
  outage?: { destination: string; seconds: number };
  tags?: number;
}

export interface LogLine {
  n: number;
  at: number;
  level: 'info' | 'warn' | 'ok';
  text: string;
}

// The terminal panel on the dashboard reads from this.
export class ChaosLog {
  lines: LogLine[] = [];
  private n = 0;
  add(text: string, level: LogLine['level'] = 'info'): void {
    this.lines.push({ n: ++this.n, at: Date.now(), level, text });
    if (this.lines.length > 500) this.lines.shift();
  }
  after(n: number): LogLine[] {
    return this.lines.filter((l) => l.n > n);
  }
  clear(): void {
    this.lines = [];
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DROP_KINDS = ['webhook', 'membership', 'email'] as const;

// Fires purchases from the mock store while the mock tools misbehave on purpose.
export async function runChaos(ctx: Ctx, opts: ChaosOptions, log: ChaosLog): Promise<{ purchases: number; dropped: number }> {
  if (!ctx.mocks) throw new Error('chaos runs only in demo mode');
  const { state, chaos } = ctx.mocks;
  chaos.off();
  chaos.configure({ failRate: opts.failRate, seed: opts.seed });
  if (opts.outage) chaos.outages.set(opts.outage.destination, Date.now() + opts.outage.seconds * 1000);

  const buyers = state.buyers().slice(0, opts.buyers);
  const dropCount = Math.round(buyers.length * opts.dropRate);
  const dropAt = new Map(seededShuffle([...buyers.keys()], opts.seed).slice(0, dropCount).map((index, i) => [index, DROP_KINDS[i % DROP_KINDS.length]]));
  const receiver = `${ctx.config.baseUrl}/webhooks/store`;
  const secret = ctx.config.sourceSecrets.store;

  log.add(`$ chaos --buyers ${buyers.length} --fail ${opts.failRate} --drop ${opts.dropRate}${opts.outage ? ` --outage ${opts.outage.destination}:${opts.outage.seconds}s` : ''}`);
  log.add(`Failures on: ${Math.round(opts.failRate * 100)}% of requests to the membership site, email sender and n8n fail or time out.`, 'warn');
  log.add(`Silent drops on: ${dropCount} events will vanish without any error.`, 'warn');
  if (opts.outage) log.add(`The ${opts.outage.destination} tool is fully down for the first ${opts.outage.seconds} seconds.`, 'warn');

  for (const [i, buyer] of buyers.entries()) {
    const product = PRODUCTS[i % PRODUCTS.length];
    const amount = [49, 199, 499][i % PRODUCTS.length];
    const event = state.createStoreEvent('purchase.created', buyer, { product, amount });
    const drop = dropAt.get(i);
    if (drop === 'webhook') {
      state.setWebhookStatus(event.id, 'lost');
      log.add(`store  purchase ${event.data.order_id} ${buyer.first_name}: webhook lost on the way`, 'warn');
    } else {
      if (drop) chaos.dropKeys.add(idempotencyKey('store', event.id, drop));
      const status = await sendStoreWebhook(event, receiver, secret);
      state.setWebhookStatus(event.id, status);
      log.add(`store  purchase ${event.data.order_id} ${buyer.first_name}: webhook ${status === 'sent' ? 'sent' : 'failed'}`, status === 'sent' ? 'info' : 'warn');
    }
    await sleep(opts.intervalMs);
  }
  for (const buyer of buyers.slice(0, opts.tags ?? 0)) {
    const event = state.createStoreEvent('tag.applied', buyer, { tag: 'VIP', orderId: state.purchasesSince(0).find((p) => p.data.buyer.id === buyer.id)?.data.order_id });
    const status = await sendStoreWebhook(event, receiver, secret);
    state.setWebhookStatus(event.id, status);
    log.add(`store  tag VIP ${buyer.first_name}: webhook ${status}`);
    await sleep(opts.intervalMs);
  }
  log.add(`Store finished: ${buyers.length} purchases sent. The guard is delivering and retrying now.`, 'ok');
  return { purchases: buyers.length, dropped: dropCount };
}

// Checks the outcome from the tools' own records: who has access, and how many welcome emails each got.
export function verifyOutcome(ctx: Ctx): { buyers: number; withAccess: number; duplicateAccounts: number; withOneWelcomeEmail: number; duplicateEmails: number; missing: string[] } {
  if (!ctx.mocks) throw new Error('verify runs only in demo mode');
  const { state } = ctx.mocks;
  const purchases = state.purchasesSince(0);
  let withAccess = 0, duplicateAccounts = 0, withOneWelcomeEmail = 0, duplicateEmails = 0;
  const missing: string[] = [];
  for (const p of purchases) {
    const accounts = state.accountsForOrder(p.data.order_id).length;
    const emails = state.welcomeEmailsForOrder(p.data.order_id).length;
    if (accounts >= 1) withAccess++;
    if (accounts > 1) duplicateAccounts += accounts - 1;
    if (emails === 1) withOneWelcomeEmail++;
    if (emails > 1) duplicateEmails += emails - 1;
    if (accounts === 0 || emails === 0) missing.push(`${p.data.buyer.first_name} (order ${p.data.order_id})`);
  }
  return { buyers: purchases.length, withAccess, duplicateAccounts, withOneWelcomeEmail, duplicateEmails, missing };
}
