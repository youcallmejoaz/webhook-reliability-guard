import type { Config } from './config.js';
import type { SourceEvent, SourceEventType } from './types.js';

// A destination is any tool that has to act on an event. Each one is a small adapter:
// which events it wants, how to send one, and (optionally) how to check that it really
// acted on it, which is what reconciliation uses to catch silent drops.

export interface Destination {
  name: string;
  label: string;
  eventTypes: SourceEventType[];
  send(event: SourceEvent, idempotencyKey: string, timeoutMs: number): Promise<SendResult>;
  verify?(event: SourceEvent): Promise<boolean>;
}

export type SendResult = { ok: true } | { ok: false; retryable: boolean; errorClass: ErrorClass; error: string };
export type ErrorClass = 'timeout' | 'http_5xx' | 'http_4xx' | 'network';

export function idempotencyKey(source: string, externalId: string, destination: string): string {
  return `${source}:${externalId}:${destination}`;
}

async function postJson(url: string, body: unknown, idempotencyKey: string, timeoutMs: number): Promise<SendResult> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return { ok: true };
    const text = (await res.text().catch(() => '')).slice(0, 200);
    const reason = `HTTP ${res.status}${text ? ` ${statusText(text)}` : ''}`;
    // 408 and 429 are worth retrying; other 4xx mean the request itself is wrong.
    if (res.status >= 500 || res.status === 408 || res.status === 429) return { ok: false, retryable: true, errorClass: 'http_5xx', error: reason };
    return { ok: false, retryable: false, errorClass: 'http_4xx', error: reason };
  } catch (err) {
    const e = err as Error;
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return { ok: false, retryable: true, errorClass: 'timeout', error: `No reply within ${(timeoutMs / 1000).toFixed(1)} s` };
    return { ok: false, retryable: true, errorClass: 'network', error: `Network error: ${e.message}` };
  }
}

function statusText(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: string };
    return parsed.error ?? '';
  } catch {
    return '';
  }
}

async function getJsonArray(url: string): Promise<unknown[]> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).pathname}`);
  return (await res.json()) as unknown[];
}

export function buildDestinations(config: Config): Destination[] {
  const membership: Destination = {
    name: 'membership',
    label: 'Membership site',
    eventTypes: ['purchase.created', 'tag.applied', 'subscription.cancelled'],
    send: (event, key, timeout) => postJson(`${config.membershipUrl}/events`, event, key, timeout),
    verify: async (event) => {
      const accounts = await getJsonArray(`${config.membershipUrl}/accounts?order_id=${encodeURIComponent(event.data.order_id)}`);
      return accounts.length > 0;
    },
  };
  const email: Destination = {
    name: 'email',
    label: 'Email sender',
    eventTypes: ['purchase.created'],
    send: (event, key, timeout) => postJson(`${config.emailUrl}/send`, event, key, timeout),
    verify: async (event) => {
      const messages = await getJsonArray(`${config.emailUrl}/messages?order_id=${encodeURIComponent(event.data.order_id)}`);
      return messages.length > 0;
    },
  };
  const n8n: Destination = {
    name: 'n8n',
    label: 'n8n workflow',
    eventTypes: ['purchase.created', 'tag.applied', 'subscription.cancelled'],
    send: (event, key, timeout) => postJson(config.n8nUrl, event, key, timeout),
  };
  return [membership, email, n8n];
}

export function destinationsFor(all: Destination[], type: SourceEventType): string[] {
  return all.filter((d) => d.eventTypes.includes(type)).map((d) => d.name);
}
