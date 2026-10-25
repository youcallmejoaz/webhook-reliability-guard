// Prints the email deliverability check for the configured sending domain.
import { api } from './api.js';

type Report = { domain: string; summary: string; checks: { name: string; status: string; verdict: string; fix: string | null; record: string | null }[] };
const r = await api<Report>('/api/email-check');
console.log(`Email check for ${r.domain}\n`);
for (const c of r.checks) {
  console.log(`${c.status.toUpperCase().padEnd(5)} ${c.name.padEnd(8)} ${c.verdict}`);
  if (c.fix) console.log(`      Fix: ${c.fix}`);
}
console.log(`\n${r.summary}`);
