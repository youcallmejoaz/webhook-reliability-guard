// Shapes shared by the receiver, the mocks and the adapters.

export interface Buyer {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
}

export type SourceEventType = 'purchase.created' | 'tag.applied' | 'subscription.cancelled';

export interface SourceEvent {
  id: string; // the source's own event id, used as the idempotency key
  type: SourceEventType;
  created_at: number;
  data: {
    order_id: string;
    buyer: Buyer;
    product?: string;
    amount?: number;
    currency?: string;
    tag?: string;
  };
}

export const EVENT_TYPES: SourceEventType[] = ['purchase.created', 'tag.applied', 'subscription.cancelled'];

export function isSourceEvent(value: unknown): value is SourceEvent {
  const v = value as SourceEvent;
  return (
    typeof v === 'object' && v !== null &&
    typeof v.id === 'string' && v.id.length > 0 && v.id.length <= 200 &&
    EVENT_TYPES.includes(v.type) &&
    typeof v.data === 'object' && v.data !== null &&
    typeof v.data.order_id === 'string' &&
    typeof v.data.buyer === 'object' && v.data.buyer !== null &&
    typeof v.data.buyer.first_name === 'string'
  );
}
