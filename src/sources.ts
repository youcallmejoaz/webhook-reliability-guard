import type { SourceEvent } from './types.js';

// A source is the store or CRM that sends webhooks. For reconciliation it also needs an API
// we can ask "what purchases happened recently?". Real sources (Keap, Stripe, WooCommerce)
// get a small adapter that maps their API to this shape.
export interface SourceAdapter {
  name: string;
  label: string;
  recentPurchases(sinceMs: number): Promise<SourceEvent[]>;
}

export function httpSource(name: string, label: string, apiUrl: string): SourceAdapter {
  return {
    name,
    label,
    async recentPurchases(sinceMs) {
      const res = await fetch(`${apiUrl}/purchases?since=${sinceMs}`, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`${label} API answered HTTP ${res.status}`);
      return (await res.json()) as SourceEvent[];
    },
  };
}
