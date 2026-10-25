import { Hono } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import { serveStatic } from '@hono/node-server/serve-static';
import { join } from 'node:path';
import type { Config } from './config.js';
import type { Ctx } from './context.js';
import { Db } from './db.js';
import { buildDestinations } from './destinations.js';
import { httpSource } from './sources.js';
import { IncidentDetector } from './incidents.js';
import { BuyerSync, csvAdapter, googleSheetsAdapter } from './buyers.js';
import { fixtureResolver, runEmailCheck, systemResolver } from './emailcheck.js';
import { receiverRoutes } from './receiver.js';
import { apiRoutes } from './api.js';
import { DeliveryWorker } from './worker.js';
import { startReconcileSchedule } from './reconcile.js';
import { MockState } from './mocks/state.js';
import { Chaos } from './mocks/chaos.js';
import { mockRoutes } from './mocks/routes.js';
import { ChaosLog } from './mocks/runner.js';

export interface Guard {
  app: Hono;
  ctx: Ctx;
  worker: DeliveryWorker;
  startBackground(): void;
  stop(): Promise<void>;
}

export function createGuard(config: Config, opts: { mockDbPath?: string } = {}): Guard {
  const db = new Db(config.dbPath);
  const destinations = buildDestinations(config);
  const mocks = config.demoMode ? { state: new MockState(opts.mockDbPath ?? join(config.dataDir, 'mocks.db')), chaos: new Chaos() } : undefined;
  const resolver = config.demoMode ? fixtureResolver() : systemResolver;

  const ctx = {
    config,
    db,
    destinations,
    destinationByName: new Map(destinations.map((d) => [d.name, d])),
    sources: new Map([['store', httpSource('store', 'store', config.sourceApiUrl)]]),
    mocks,
    emailCheck: async () => {
      // Bounces come from the email sender's log. In demo mode that is the mock sender.
      let bounceLog = { sent: 0, bounced: 0 };
      try {
        const res = await fetch(`${config.emailUrl}/log?since=${Date.now() - 24 * 60 * 60_000}`, { signal: AbortSignal.timeout(5_000) });
        if (res.ok) bounceLog = (await res.json()) as typeof bounceLog;
      } catch {
        // No log available: report only the DNS checks.
      }
      return runEmailCheck(config, resolver, bounceLog);
    },
  } as Ctx;
  ctx.incidents = new IncidentDetector(ctx);
  const adapter = config.sheetsAdapter === 'google' ? googleSheetsAdapter(config.googleSheetId, config.googleServiceAccountJson) : csvAdapter(config.dataDir);
  ctx.buyerSync = new BuyerSync(ctx, adapter);

  const worker = new DeliveryWorker(ctx);
  const chaosLog = new ChaosLog();
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true, demoMode: config.demoMode }));
  app.route('/webhooks', receiverRoutes(ctx));
  if (mocks) app.route('/mock', mockRoutes(mocks.state, mocks.chaos));

  const password = process.env.DASHBOARD_PASSWORD;
  if (password) {
    const guard = basicAuth({ username: process.env.DASHBOARD_USER || 'admin', password });
    app.use('/api/*', guard);
    app.use('/', guard);
  }
  app.route('/api', apiRoutes(ctx, chaosLog));
  // Paths are relative to the working directory: start the server from the repo root (npm scripts do).
  app.use('/*', serveStatic({ root: 'public' }));

  let stopSchedule: (() => void) | null = null;
  return {
    app,
    ctx,
    worker,
    startBackground() {
      worker.start();
      stopSchedule = startReconcileSchedule(ctx);
    },
    async stop() {
      stopSchedule?.();
      await worker.stop();
      await ctx.incidents.settle();
      ctx.buyerSync.stop();
      db.close();
      mocks?.state.close();
    },
  };
}
