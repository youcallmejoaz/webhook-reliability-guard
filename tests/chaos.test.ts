import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestGuard, type TestGuard } from './helpers.js';
import { runChaos, verifyOutcome, ChaosLog } from '../src/mocks/runner.js';
import { reconcile } from '../src/reconcile.js';

describe('chaos: 50 buyers, 20% failures, 5% silent drops', () => {
  let g: TestGuard;
  beforeAll(async () => {
    g = await startTestGuard();
  });
  afterAll(async () => {
    await g.close();
  });

  it('gives every buyer access and exactly one welcome email', async () => {
    const log = new ChaosLog();
    const run = await runChaos(g.ctx, { buyers: 50, failRate: 0.2, dropRate: 0.05, seed: 7, intervalMs: 0 }, log);
    expect(run).toEqual({ purchases: 50, dropped: 3 });
    await g.worker.drain();

    // Some failures really happened and were retried.
    const failed = g.ctx.db.sql.prepare("SELECT COUNT(*) AS n FROM timeline WHERE kind = 'attempt_failed'").get() as { n: number };
    expect(failed.n).toBeGreaterThan(20);

    // Before reconciliation, the silent drops are invisible: 3 buyers are missing something.
    expect(verifyOutcome(g.ctx).missing).toHaveLength(3);

    const result = await reconcile(g.ctx);
    expect(result.misses).toHaveLength(3);
    await g.worker.drain();

    const outcome = verifyOutcome(g.ctx);
    expect(outcome).toMatchObject({ buyers: 50, withAccess: 50, duplicateAccounts: 0, withOneWelcomeEmail: 50, duplicateEmails: 0, missing: [] });
    const dead = g.ctx.db.sql.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE status = 'dead'").get() as { n: number };
    expect(dead.n).toBe(0);
  }, 90_000);
});
