import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestGuard, type TestGuard } from './helpers.js';
import { sign, verify } from '../src/signature.js';

describe('webhook receiver', () => {
  let g: TestGuard;
  let body: string;
  beforeAll(async () => {
    g = await startTestGuard();
    const { state } = g.ctx.mocks!;
    body = JSON.stringify(state.createStoreEvent('purchase.created', state.buyers()[0], { product: 'Starter Course', amount: 49 }));
  });
  afterAll(async () => {
    await g.close();
  });

  const post = (headers: Record<string, string>, payload = body, source = 'store') =>
    fetch(`${g.baseUrl}/webhooks/${source}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: payload });
  const rejected = () => g.ctx.db.sql.prepare('SELECT reason FROM rejected_webhooks ORDER BY id').all() as { reason: string }[];
  const events = () => (g.ctx.db.sql.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;

  it('rejects an unsigned webhook and logs it', async () => {
    const res = await post({});
    expect(res.status).toBe(401);
    expect(rejected().at(-1)!.reason).toBe('missing signature header');
    expect(events()).toBe(0);
  });

  it('rejects a webhook signed with the wrong secret', async () => {
    const res = await post({ 'x-webhook-signature': sign(body, 'not-the-secret') });
    expect(res.status).toBe(401);
    expect(rejected().at(-1)!.reason).toBe('signature does not match');
  });

  it('rejects a replayed old signature', async () => {
    const old = Math.floor(Date.now() / 1000) - 3600;
    const res = await post({ 'x-webhook-signature': sign(body, g.ctx.config.sourceSecrets.store, old) });
    expect(res.status).toBe(401);
    expect(rejected().at(-1)!.reason).toBe('signature timestamp outside tolerance');
  });

  it('rejects a body that was changed after signing', async () => {
    const res = await post({ 'x-webhook-signature': sign(body, g.ctx.config.sourceSecrets.store) }, body.replace('Starter Course', 'Free Course'));
    expect(res.status).toBe(401);
  });

  it('rejects unknown sources', async () => {
    const res = await post({ 'x-webhook-signature': sign(body, g.ctx.config.sourceSecrets.store) }, body, 'someone-else');
    expect(res.status).toBe(404);
  });

  it('does not store the body of rejected webhooks', () => {
    const cols = g.ctx.db.sql.prepare('PRAGMA table_info(rejected_webhooks)').all() as { name: string }[];
    expect(cols.map((c) => c.name)).toEqual(['id', 'source', 'at', 'reason', 'body_sha256']);
  });

  it('accepts a correctly signed webhook and saves it before replying', async () => {
    const res = await post({ 'x-webhook-signature': sign(body, g.ctx.config.sourceSecrets.store) });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { id: string };
    // By the time the reply arrives the event and one delivery per tool are already stored.
    expect(g.ctx.db.getEvent(json.id)).toBeDefined();
    expect(g.ctx.db.deliveriesForEvent(json.id).map((d) => d.destination)).toEqual(['email', 'membership', 'n8n']);
  });

  it('verify() handles malformed headers', () => {
    expect(verify(body, 'garbage', 's', 300).ok).toBe(false);
    expect(verify(body, 't=abc,v1=00', 's', 300).ok).toBe(false);
    expect(verify(body, sign(body, 's'), '', 300).ok).toBe(false);
  });
});
