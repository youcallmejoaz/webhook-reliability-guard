// Tiny client for the scripts that talk to a running server.
export const BASE = process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (process.env.DASHBOARD_PASSWORD) {
    headers.authorization = `Basic ${Buffer.from(`${process.env.DASHBOARD_USER || 'admin'}:${process.env.DASHBOARD_PASSWORD}`).toString('base64')}`;
  }
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...init, headers });
  } catch {
    console.error(`Cannot reach the server at ${BASE}. Start it with "npm run dev" first.`);
    process.exit(1);
  }
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
