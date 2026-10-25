import { serve } from '@hono/node-server';
import { loadConfig, useRealClaude } from './config.js';
import { createGuard } from './app.js';
import { demoBuyers } from './mocks/buyers.js';

const config = loadConfig();
const guard = createGuard(config);

// First start in demo mode: load the 50 fictional buyers so the chaos test works straight away.
if (config.demoMode && guard.ctx.mocks && guard.ctx.mocks.state.buyers().length === 0) {
  guard.ctx.mocks.state.reset(demoBuyers(50));
  console.log('Loaded 50 fictional demo buyers. Run "npm run seed" any time to start over.');
}

guard.startBackground();
const server = serve({ fetch: guard.app.fetch, port: config.port, hostname: process.env.HOST ?? '0.0.0.0' }, () => {
  console.log(`webhook-reliability-guard on ${config.baseUrl} (demo mode: ${config.demoMode ? 'on' : 'off'}, Claude: ${useRealClaude(config) ? config.anthropicModel : 'recorded answers'})`);
});

async function shutdown() {
  server.close();
  await guard.stop();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
