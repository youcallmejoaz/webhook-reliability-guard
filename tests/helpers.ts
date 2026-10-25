import { serve, type ServerType } from '@hono/node-server';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '../src/config.js';
import { createGuard, type Guard } from '../src/app.js';
import { demoBuyers } from '../src/mocks/buyers.js';

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

export interface TestGuard extends Guard {
  baseUrl: string;
  close(): Promise<void>;
}

// A full guard with mock tools on a random port, fast timings, temp databases and no API keys.
export async function startTestGuard(overrides: Partial<Config> = {}): Promise<TestGuard> {
  delete process.env.ANTHROPIC_API_KEY;
  process.env.DEMO_MODE = '1';
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dir = mkdtempSync(join(tmpdir(), 'guard-test-'));
  const config = loadConfig({
    port,
    baseUrl,
    dbPath: join(dir, 'guard.db'),
    dataDir: dir,
    membershipUrl: `${baseUrl}/mock/membership`,
    emailUrl: `${baseUrl}/mock/email`,
    n8nUrl: `${baseUrl}/mock/n8n`,
    sourceApiUrl: `${baseUrl}/mock/store`,
    maxAttempts: 5,
    backoffBaseMs: 40,
    backoffMaxMs: 400,
    requestTimeoutMs: 300,
    workerPollMs: 20,
    reconcileGraceSeconds: 0,
    incidentDelaySeconds: 0,
    ...overrides,
  });
  const guard = createGuard(config, { mockDbPath: join(dir, 'mocks.db') });
  guard.ctx.mocks!.state.reset(demoBuyers(50));
  guard.ctx.mocks!.chaos.hangMs = 600;
  const server: ServerType = serve({ fetch: guard.app.fetch, port, hostname: '127.0.0.1' });
  guard.worker.start();
  return {
    ...guard,
    baseUrl,
    async close() {
      await new Promise((r) => server.close(r));
      await guard.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
