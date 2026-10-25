// All settings come from environment variables. Defaults are safe for demo mode.

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (Number.isNaN(value)) throw new Error(`${name} must be a number, got "${raw}"`);
  return value;
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

export interface Config {
  demoMode: boolean;
  port: number;
  baseUrl: string;
  dbPath: string;
  dataDir: string;
  // Webhook signing secrets per source, for example { store: "..." }.
  sourceSecrets: Record<string, string>;
  signatureToleranceSeconds: number;
  // Delivery worker
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  requestTimeoutMs: number;
  workerPollMs: number;
  // Destinations
  membershipUrl: string;
  emailUrl: string;
  n8nUrl: string;
  // Reconciliation
  reconcileIntervalMinutes: number;
  reconcileLookbackMinutes: number;
  reconcileGraceSeconds: number;
  sourceApiUrl: string;
  // Incidents and Claude
  incidentFailureThreshold: number;
  incidentWindowMinutes: number;
  incidentDelaySeconds: number;
  anthropicApiKey: string;
  anthropicModel: string;
  slackWebhookUrl: string;
  slackChannel: string;
  // Email check
  emailDomain: string;
  dkimSelectors: string[];
  // Buyer list sync
  sheetsAdapter: 'csv' | 'google';
  googleSheetId: string;
  googleServiceAccountJson: string;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const demoMode = str('DEMO_MODE', '1') !== '0';
  const port = num('PORT', 3000);
  const baseUrl = str('BASE_URL', `http://localhost:${port}`);
  const config: Config = {
    demoMode,
    port,
    baseUrl,
    dbPath: str('DB_PATH', 'data/guard.db'),
    dataDir: str('DATA_DIR', 'data'),
    sourceSecrets: { store: str('STORE_WEBHOOK_SECRET', demoMode ? 'demo-store-secret' : '') },
    signatureToleranceSeconds: num('SIGNATURE_TOLERANCE_SECONDS', 300),
    maxAttempts: num('MAX_ATTEMPTS', demoMode ? 5 : 8),
    backoffBaseMs: num('BACKOFF_BASE_MS', demoMode ? 700 : 30_000),
    backoffMaxMs: num('BACKOFF_MAX_MS', demoMode ? 8_000 : 60 * 60_000),
    requestTimeoutMs: num('REQUEST_TIMEOUT_MS', demoMode ? 1_500 : 10_000),
    workerPollMs: num('WORKER_POLL_MS', demoMode ? 200 : 1_000),
    membershipUrl: str('MEMBERSHIP_URL', `${baseUrl}/mock/membership`),
    emailUrl: str('EMAIL_URL', `${baseUrl}/mock/email`),
    n8nUrl: str('N8N_WEBHOOK_URL', `${baseUrl}/mock/n8n`),
    reconcileIntervalMinutes: num('RECONCILE_INTERVAL_MINUTES', 15),
    reconcileLookbackMinutes: num('RECONCILE_LOOKBACK_MINUTES', 24 * 60),
    reconcileGraceSeconds: num('RECONCILE_GRACE_SECONDS', demoMode ? 3 : 120),
    sourceApiUrl: str('SOURCE_API_URL', `${baseUrl}/mock/store`),
    incidentFailureThreshold: num('INCIDENT_FAILURE_THRESHOLD', 5),
    incidentWindowMinutes: num('INCIDENT_WINDOW_MINUTES', 10),
    incidentDelaySeconds: num('INCIDENT_DELAY_SECONDS', demoMode ? 6 : 60),
    anthropicApiKey: str('ANTHROPIC_API_KEY', ''),
    anthropicModel: str('ANTHROPIC_MODEL', 'claude-haiku-5-5'),
    slackWebhookUrl: str('SLACK_WEBHOOK_URL', ''),
    slackChannel: str('SLACK_CHANNEL', '#automation-alerts'),
    emailDomain: str('EMAIL_DOMAIN', 'demo-academy.example'),
    dkimSelectors: str('DKIM_SELECTORS', 's1').split(',').map((s) => s.trim()).filter(Boolean),
    sheetsAdapter: str('SHEETS_ADAPTER', 'csv') === 'google' ? 'google' : 'csv',
    googleSheetId: str('GOOGLE_SHEET_ID', ''),
    googleServiceAccountJson: str('GOOGLE_SERVICE_ACCOUNT_JSON', ''),
    ...overrides,
  };
  if (!config.demoMode && !config.sourceSecrets.store) {
    throw new Error('STORE_WEBHOOK_SECRET is required when DEMO_MODE=0');
  }
  return config;
}

// Claude is only called for real when demo mode is off and a key is present.
export function useRealClaude(config: Config): boolean {
  return !config.demoMode && config.anthropicApiKey !== '';
}
