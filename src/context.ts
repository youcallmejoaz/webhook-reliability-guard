import type { Config } from './config.js';
import type { Db } from './db.js';
import type { Destination } from './destinations.js';
import type { IncidentDetector } from './incidents.js';
import type { BuyerSync } from './buyers.js';
import type { MockState } from './mocks/state.js';
import type { Chaos } from './mocks/chaos.js';
import type { SourceAdapter } from './sources.js';
import type { EmailCheckReport } from './emailcheck.js';

// Everything the routes and background jobs share.
export interface Ctx {
  config: Config;
  db: Db;
  destinations: Destination[];
  destinationByName: Map<string, Destination>;
  sources: Map<string, SourceAdapter>;
  incidents: IncidentDetector;
  buyerSync: BuyerSync;
  emailCheck: () => Promise<EmailCheckReport>;
  mocks?: { state: MockState; chaos: Chaos };
}
