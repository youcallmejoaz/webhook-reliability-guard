import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Chaos } from './chaos.js';
import type { MockState } from './state.js';
import { bounces } from './buyers.js';
import { isSourceEvent, type SourceEvent } from '../types.js';
import { sign, SIGNATURE_HEADER } from '../signature.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The mock outside world: a store, a membership site, an email sender and an n8n webhook.
export function mockRoutes(state: MockState, chaos: Chaos): Hono {
  const app = new Hono();

  async function destination(c: Context, name: string, work: (event: SourceEvent) => void) {
    const key = c.req.header('idempotency-key');
    if (!key) return c.json({ error: 'Idempotency-Key header is required' }, 400);
    const event = await c.req.json().catch(() => null);
    if (!isSourceEvent(event)) return c.json({ error: 'invalid event body' }, 400);
    const attempt = (chaos.attempts.get(key) ?? 0) + 1;
    chaos.attempts.set(key, attempt);
    const outcome = chaos.decide(name, key, attempt);
    const process = () => {
      if (state.claimKey(name, key)) work(event);
    };
    switch (outcome) {
      case 'outage':
      case 'http_503':
        return c.json({ error: 'Service Unavailable' }, 503);
      case 'http_500':
        return c.json({ error: 'Internal Server Error' }, 500);
      case 'timeout_unprocessed':
        await sleep(chaos.hangMs);
        return c.json({ error: 'Gateway Timeout' }, 504);
      case 'timeout_processed':
        process();
        await sleep(chaos.hangMs);
        return c.json({ ok: true });
      case 'silent_drop':
        // Says "ok" but does nothing. This is the failure that only reconciliation can catch.
        return c.json({ ok: true });
      case 'ok':
        process();
        return c.json({ ok: true });
    }
  }

  app.post('/membership/events', (c) => destination(c, 'membership', (e) => state.applyMembership(e)));
  app.get('/membership/accounts', (c) => c.json(state.accountsForOrder(c.req.query('order_id') ?? '').map(({ id, order_id, status, tags }) => ({ id, order_id, status, tags }))));

  app.post('/email/send', (c) => destination(c, 'email', (e) => state.sendEmail(e, bounces(e.data.buyer))));
  app.get('/email/messages', (c) => c.json(state.welcomeEmailsForOrder(c.req.query('order_id') ?? '').map(({ id, order_id, status, at }) => ({ id, order_id, status, at }))));
  app.get('/email/log', (c) => {
    const rows = state.emails(Number(c.req.query('since') ?? 0));
    return c.json({ sent: rows.length, bounced: rows.filter((r) => r.status === 'bounced').length });
  });

  app.post('/n8n', (c) => destination(c, 'n8n', (e) => state.recordN8n(e)));

  app.get('/store/purchases', (c) => c.json(state.purchasesSince(Number(c.req.query('since') ?? 0))));

  return app;
}

// The mock store sends its webhook the way a real store does: signed, one try, no guarantees.
export async function sendStoreWebhook(event: SourceEvent, receiverUrl: string, secret: string): Promise<'sent' | 'failed'> {
  const body = JSON.stringify(event);
  try {
    const res = await fetch(receiverUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: sign(body, secret) },
      body,
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok ? 'sent' : 'failed';
  } catch {
    return 'failed';
  }
}
