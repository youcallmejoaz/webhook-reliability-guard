import { createHash } from 'node:crypto';

// Chaos settings for the mock destinations. Every decision is a pure function of
// (seed, idempotency key, attempt number), so a run behaves the same no matter how
// requests interleave. That keeps the tests and the recorded clips repeatable.

export type ChaosOutcome = 'ok' | 'http_503' | 'http_500' | 'timeout_unprocessed' | 'timeout_processed' | 'silent_drop' | 'outage';

export class Chaos {
  enabled = false;
  failRate = 0;
  seed = 1;
  hangMs = 3_000;
  // destination -> epoch ms until which every request fails with 503
  outages = new Map<string, number>();
  // destination idempotency keys that are silently dropped on their first request
  dropKeys = new Set<string>();
  // idempotency key -> how many requests the mock tools have seen for it
  attempts = new Map<string, number>();

  configure(opts: { failRate: number; seed?: number; hangMs?: number }): void {
    this.enabled = true;
    this.failRate = opts.failRate;
    this.seed = opts.seed ?? this.seed;
    if (opts.hangMs !== undefined) this.hangMs = opts.hangMs;
  }

  off(): void {
    this.enabled = false;
    this.failRate = 0;
    this.outages.clear();
    this.dropKeys.clear();
    this.attempts.clear();
  }

  decide(destination: string, key: string, attempt: number, now = Date.now()): ChaosOutcome {
    const until = this.outages.get(destination);
    if (until !== undefined && now < until) return 'outage';
    if (this.dropKeys.delete(key)) return 'silent_drop';
    if (!this.enabled || this.failRate <= 0) return 'ok';
    const roll = unit(`${this.seed}|${key}|${attempt}`);
    if (roll >= this.failRate) return 'ok';
    // Split failures: 55% service unavailable, 15% server error, 30% timeouts (half of them after the work was done).
    const kind = roll / this.failRate;
    if (kind < 0.55) return 'http_503';
    if (kind < 0.7) return 'http_500';
    if (kind < 0.85) return 'timeout_unprocessed';
    return 'timeout_processed';
  }
}

export function unit(input: string): number {
  return createHash('sha256').update(input).digest().readUInt32BE(0) / 0x1_0000_0000;
}

// Seeded Fisher-Yates shuffle, used to pick which events get dropped.
export function seededShuffle<T>(items: T[], seed: number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(unit(`${seed}|shuffle|${i}`) * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
