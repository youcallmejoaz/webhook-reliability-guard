import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestGuard, type TestGuard } from './helpers.js';
import { sendStoreWebhook } from '../src/mocks/routes.js';
import { replayDelivery, replayEvent } from '../src/worker.js';
import { verifyOutcome } from '../src/mocks/runner.js';

describe('replay and dead letter', () => {
  let g: TestGuard;
  beforeAll(async () => {
    g = await startTestGuard();
  });
  afterAll(async () => {
    await g.close();
  });

  async function purchase(i: number) {
    const { state } = g.ctx.mocks!;
    const buyer = state.buyers()[i];
    const event = state.createStoreEvent('purchase.created', buyer, { product: 'Starter Course', amount: 49 });
    expect(await sendStoreWebhook(event, `${g.baseUrl}/webhooks/store`, g.ctx.config.sourceSecrets.store)).toBe('sent');
    return { event, row: g.ctx.db.findEvent('store', event.id)! };
  }

  it('replaying an already delivered event creates no duplicate', async () => {
    const { event, row } = await purchase(0);
    await g.worker.drain();
    expect(g.ctx.db.deliveriesForEvent(row.id).every((d) => d.status === 'delivered')).toBe(true);

    replayEvent(g.ctx, row.id);
    replayEvent(g.ctx, row.id);
    await g.worker.drain();

    const { state } = g.ctx.mocks!;
    expect(state.accountsForOrder(event.data.order_id)).toHaveLength(1);
    expect(state.welcomeEmailsForOrder(event.data.order_id)).toHaveLength(1);
    const n8n = state.sql.prepare('SELECT COUNT(*) AS n FROM n8n_calls WHERE order_id = ?').get(event.data.order_id) as { n: number };
    expect(n8n.n).toBe(1);
    expect(g.ctx.db.timeline(row.id).filter((t) => t.kind === 'replayed')).toHaveLength(6);
  });

  it('sending the same webhook twice stores it once', async () => {
    const { state } = g.ctx.mocks!;
    const buyer = state.buyers()[1];
    const event = state.createStoreEvent('purchase.created', buyer, { product: 'Pro Membership', amount: 199 });
    await sendStoreWebhook(event, `${g.baseUrl}/webhooks/store`, g.ctx.config.sourceSecrets.store);
    const res = await fetch(`${g.baseUrl}/webhooks/store`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-signature': (await import('../src/signature.js')).sign(JSON.stringify(event), g.ctx.config.sourceSecrets.store) },
      body: JSON.stringify(event),
    });
    expect(await res.json()).toEqual({ ok: true, duplicate: true });
    await g.worker.drain();
    expect(state.welcomeEmailsForOrder(event.data.order_id)).toHaveLength(1);
  });

  it('moves deliveries past the retry limit to the dead letter queue, and replay delivers them', async () => {
    const { chaos, state } = g.ctx.mocks!;
    chaos.outages.set('email', Date.now() + 60_000);
    const { event, row } = await purchase(2);
    await g.worker.drain();

    const email = g.ctx.db.deliveriesForEvent(row.id).find((d) => d.destination === 'email')!;
    expect(email.status).toBe('dead');
    expect(email.attempts).toBe(g.ctx.config.maxAttempts);
    expect(state.welcomeEmailsForOrder(event.data.order_id)).toHaveLength(0);
    // The other tools were not held back by the email outage.
    expect(state.accountsForOrder(event.data.order_id)).toHaveLength(1);

    chaos.off(); // the email sender is back
    expect(replayDelivery(g.ctx, email.id)).toBe(true);
    await g.worker.drain();
    expect(g.ctx.db.getDelivery(email.id)!.status).toBe('delivered');
    expect(state.welcomeEmailsForOrder(event.data.order_id)).toHaveLength(1);
  });

  it('sends errors that retrying cannot fix straight to the dead letter queue', async () => {
    const n8n = g.ctx.destinationByName.get('n8n')!;
    const send = n8n.send;
    n8n.send = async () => ({ ok: false, retryable: false, errorClass: 'http_4xx', error: 'HTTP 401 Unauthorized' });
    const { row } = await purchase(4);
    await g.worker.drain();
    n8n.send = send;
    const d = g.ctx.db.deliveriesForEvent(row.id).find((x) => x.destination === 'n8n')!;
    expect(d.status).toBe('dead');
    expect(d.attempts).toBe(1);
  });

  it('a timeout after the tool already did the work does not cause a duplicate', async () => {
    const { chaos, state } = g.ctx.mocks!;
    const { event } = await purchase(3);
    // Force the next email attempt for this event to be processed and then hang past our timeout.
    const key = `store:${event.id}:email`;
    const original = chaos.decide.bind(chaos);
    let forced = false;
    chaos.decide = (dest, k, attempt, now) => {
      if (k === key && !forced) {
        forced = true;
        return 'timeout_processed';
      }
      return original(dest, k, attempt, now);
    };
    await g.worker.drain();
    chaos.decide = original;
    expect(forced).toBe(true);
    expect(state.welcomeEmailsForOrder(event.data.order_id)).toHaveLength(1);
    const row = g.ctx.db.findEvent('store', event.id)!;
    const email = g.ctx.db.deliveriesForEvent(row.id).find((d) => d.destination === 'email')!;
    expect(email.attempts).toBeGreaterThanOrEqual(2);
    expect(verifyOutcome(g.ctx).duplicateEmails).toBe(0);
  });
});
