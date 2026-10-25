// Resets the demo databases and loads 50 fictional buyers into the mock store.
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { Db } from '../src/db.js';
import { MockState } from '../src/mocks/state.js';
import { demoBuyers } from '../src/mocks/buyers.js';

const config = loadConfig();
if (!config.demoMode) {
  console.error('Seeding only runs in demo mode (DEMO_MODE=1). It would wipe real data otherwise.');
  process.exit(1);
}
// If the server is running, reset through it so its in-memory state resets too.
try {
  const res = await fetch(`${process.env.BASE_URL ?? `http://localhost:${config.port}`}/api/demo/reset`, { method: 'POST', signal: AbortSignal.timeout(2_000) });
  if (res.ok) {
    console.log('Reset the running server: 50 fictional buyers loaded, guard database and mock tools empty.');
    process.exit(0);
  }
} catch {
  // Server not running: reset the files directly.
}
const db = new Db(config.dbPath);
db.reset();
db.close();
const mocks = new MockState(join(config.dataDir, 'mocks.db'));
const buyers = demoBuyers(50);
mocks.reset(buyers);
mocks.close();
rmSync(join(config.dataDir, 'buyers.csv'), { force: true });
console.log(`Seeded ${buyers.length} fictional buyers. Guard database and mock tools are empty and ready.`);
