import type { SourceEvent } from './types.js';

// Anything that leaves the system for Slack or Claude goes through these helpers.
// Only the first name and the order number survive.

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

export function maskBuyer(event: Pick<SourceEvent, 'data'>): string {
  return `${event.data.buyer.first_name} (order ${event.data.order_id})`;
}

export function maskedEventSummary(event: SourceEvent): Record<string, string> {
  const out: Record<string, string> = {
    type: event.type,
    buyer: event.data.buyer.first_name,
    order: event.data.order_id,
  };
  if (event.data.product) out.product = event.data.product;
  if (event.data.tag) out.tag = event.data.tag;
  return out;
}

// Removes email addresses and any of the given words (for example last names) from free text.
export function scrub(text: string, hiddenWords: string[] = []): string {
  let out = text.replace(EMAIL, '[email hidden]');
  for (const word of hiddenWords) {
    if (word.length < 2) continue;
    out = out.replace(new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), '[hidden]');
  }
  return out;
}

// For the dashboard buyer list: "ada.okafor7@example.com" -> "ad***@example.com".
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at < 1) return '***';
  return `${email.slice(0, Math.min(2, at))}***${email.slice(at)}`;
}
