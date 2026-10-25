import { createHmac, timingSafeEqual } from 'node:crypto';

// Header format: "t=<unix seconds>,v1=<hex hmac-sha256 of `${t}.${body}`>".
// This is the same shape Stripe uses; other sources get a small adapter that maps to it.
export const SIGNATURE_HEADER = 'x-webhook-signature';

export function sign(body: string, secret: string, timestampSeconds = Math.floor(Date.now() / 1000)): string {
  const mac = createHmac('sha256', secret).update(`${timestampSeconds}.${body}`).digest('hex');
  return `t=${timestampSeconds},v1=${mac}`;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export function verify(body: string, header: string | undefined, secret: string, toleranceSeconds: number, nowSeconds = Math.floor(Date.now() / 1000)): VerifyResult {
  if (!secret) return { ok: false, reason: 'no signing secret configured for this source' };
  if (!header) return { ok: false, reason: 'missing signature header' };
  const parts = Object.fromEntries(
    header.split(',').map((part) => {
      const i = part.indexOf('=');
      return [part.slice(0, i).trim(), part.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  if (!parts.t || !Number.isInteger(t)) return { ok: false, reason: 'malformed signature header' };
  if (!parts.v1 || !/^[0-9a-f]{64}$/.test(parts.v1)) return { ok: false, reason: 'malformed signature header' };
  if (Math.abs(nowSeconds - t) > toleranceSeconds) return { ok: false, reason: 'signature timestamp outside tolerance' };
  const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest();
  const given = Buffer.from(parts.v1, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'signature does not match' };
  return { ok: true };
}
