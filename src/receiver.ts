import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import type { Ctx } from './context.js';
import { verify, SIGNATURE_HEADER } from './signature.js';
import { isSourceEvent } from './types.js';
import { destinationsFor } from './destinations.js';
import { maskBuyer } from './mask.js';

const MAX_BODY_BYTES = 256 * 1024;

// POST /webhooks/:source
// Order matters: verify, then save the event and its deliveries in one transaction, then reply.
// If saving fails we answer 500 so the source retries; we never reply 200 for an event we do not have.
export function receiverRoutes(ctx: Ctx): Hono {
  const app = new Hono();

  app.post('/:source', async (c) => {
    const source = c.req.param('source');
    const body = await c.req.text();
    const reject = (status: 400 | 401 | 404 | 413, reason: string) => {
      ctx.db.sql
        .prepare('INSERT INTO rejected_webhooks (source, at, reason, body_sha256) VALUES (?, ?, ?, ?)')
        .run(source.slice(0, 50), Date.now(), reason, createHash('sha256').update(body).digest('hex'));
      return c.json({ error: reason }, status);
    };

    if (Buffer.byteLength(body) > MAX_BODY_BYTES) return reject(413, 'body too large');
    if (!ctx.sources.has(source)) return reject(404, 'unknown source');
    const secret = ctx.config.sourceSecrets[source] ?? '';
    const check = verify(body, c.req.header(SIGNATURE_HEADER), secret, ctx.config.signatureToleranceSeconds);
    if (!check.ok) return reject(401, check.reason);

    let event: unknown;
    try {
      event = JSON.parse(body);
    } catch {
      return reject(400, 'body is not valid JSON');
    }
    if (!isSourceEvent(event)) return reject(400, 'body is not a recognised event');

    try {
      const row = ctx.db.insertEvent({
        source,
        externalId: event.id,
        type: event.type,
        payload: event,
        origin: 'webhook',
        destinations: destinationsFor(ctx.destinations, event.type),
      });
      if (!row) return c.json({ ok: true, duplicate: true });
      ctx.db.addTimeline(row.id, 'received', `Received ${event.type} for ${maskBuyer(event)} from the ${ctx.sources.get(source)!.label}. Signature checked and event saved.`);
      return c.json({ ok: true, id: row.id });
    } catch (err) {
      console.error('failed to store event', (err as Error).message);
      return c.json({ error: 'could not store event, please retry' }, 500);
    }
  });

  return app;
}
