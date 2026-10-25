import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestGuard, type TestGuard } from './helpers.js';
import { sendStoreWebhook } from '../src/mocks/routes.js';
import { idempotencyKey } from '../src/destinations.js';
import { reconcile } from '../src/reconcile.js';

// Fixture: 10 purchases, three of them silently lost in three different ways.
describe('reconciliation', () => {
  let g: TestGuard;
  const dropped = new Map<string, string>(); // order id -> how it was lost
  beforeAll(async () => {
    g = await startTestGuard();
    const { state, chaos } = g.ctx.mocks!;
    for (const [i, buyer] of state.buyers().slice(0, 10).entries()) {
      const event = state.createStoreEvent('purchase.created', buyer, { product: 'Starter Course', amount: 49 });
      if (i === 2) {
        dropped.set(event.data.order_id, 'missed_webhook'); // the store never sends it
        continue;
      }
      if (i === 5) {
        chaos.dropKeys.add(idempotencyKey('store', event.id, 'membership'));
        dropped.set(event.data.order_id, 'destination_dropped:membership');
      }
      if (i === 8) {
        chaos.dropKeys.add(idempotencyKey('store', event.id, 'email'));
        dropped.set(event.data.order_id, 'destination_dropped:email');
      }
      await sendStoreWebhook(event, `${g.baseUrl}/webhooks/store`, g.ctx.config.sourceSecrets.store);
    }
    await g.worker.drain();
  });
  afterAll(async () => {
    await g.close();
  });

  it('finds every silently dropped event and nothing else', async () => {
    const result = await reconcile(g.ctx);
    expect(result.checked).toBe(10);
    const found = new Map(result.misses.map((m) => [m.orderId, m.destination ? `${m.kind}:${m.destination}` : m.kind]));
    expect(found).toEqual(dropped);
  });

  it('replays them so the buyers end up with access and one email', async () => {
    await g.worker.drain();
    const { state } = g.ctx.mocks!;
    for (const orderId of dropped.keys()) {
      expect(state.accountsForOrder(orderId)).toHaveLength(1);
      expect(state.welcomeEmailsForOrder(orderId)).toHaveLength(1);
    }
  });

  it('finds nothing on the next run', async () => {
    const result = await reconcile(g.ctx);
    expect(result.misses).toHaveLength(0);
  });

  it('leaves purchases inside the grace period alone', async () => {
    g.ctx.config.reconcileGraceSeconds = 60;
    const { state } = g.ctx.mocks!;
    state.createStoreEvent('purchase.created', state.buyers()[20], { product: 'Starter Course', amount: 49 }); // webhook not sent yet
    const result = await reconcile(g.ctx);
    expect(result.misses).toHaveLength(0);
    g.ctx.config.reconcileGraceSeconds = 0;
  });

  it('records a silent miss alert in Slack, masked', async () => {
    await g.ctx.incidents.settle();
    const msgs = g.ctx.db.sql.prepare('SELECT title, text FROM slack_messages').all() as { title: string; text: string }[];
    const alert = msgs.find((m) => m.title === 'Reconciliation caught silent misses');
    expect(alert).toBeDefined();
    expect(alert!.text).toContain('3 silent misses');
  });
});
