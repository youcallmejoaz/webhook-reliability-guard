// Runs the chaos test against a running server in demo mode:
// 50 purchases with failures and silent drops, then reconciliation, then a check of the outcome.
//   npm run chaos -- --fail 0.2 --drop 0.05 [--outage email:10] [--no-reconcile]
import { api, arg, sleep } from './api.js';

const failRate = Number(arg('fail', '0.2'));
const dropRate = Number(arg('drop', '0.05'));
const buyers = Number(arg('buyers', '50'));
const seed = Number(arg('seed', '7'));
const outageArg = arg('outage', '');
const [outageDestination, outageSeconds] = outageArg ? outageArg.split(':') : [undefined, undefined];

type Stats = { inProgress: number; retrying: number; deadLetter: number; delivered: number; eventsToday: number; silentMisses: number; failedAttempts: number };

async function waitForQuiet(label: string) {
  for (;;) {
    const s = await api<Stats>('/api/stats');
    process.stdout.write(`\r${label}: ${s.delivered} fully delivered, ${s.inProgress} in progress, ${s.retrying} retrying, ${s.deadLetter} in dead letter   `);
    if (s.inProgress === 0) break;
    await sleep(500);
  }
  process.stdout.write('\n');
}

let after = 0;
async function printLog() {
  const { running, lines } = await api<{ running: boolean; lines: { n: number; text: string }[] }>(`/api/chaos/log?after=${after}`);
  for (const l of lines) {
    console.log(l.text);
    after = l.n;
  }
  return running;
}

await api('/api/chaos/start', { method: 'POST', body: JSON.stringify({ buyers, failRate, dropRate, seed, outageDestination, outageSeconds: outageSeconds ? Number(outageSeconds) : undefined }) });
await sleep(200);
while (await printLog()) await sleep(300);
await waitForQuiet('Delivering');

if (!process.argv.includes('--no-reconcile')) {
  await sleep(3500); // let the newest purchases pass the reconciliation grace period
  const r = await api<{ checked: number; misses: { kind: string; orderId: string; firstName: string; destination: string | null }[] }>('/api/reconciliation/run', { method: 'POST' });
  console.log(`Reconciliation checked ${r.checked} purchases and found ${r.misses.length} silent misses:`);
  for (const m of r.misses) console.log(`  ${m.firstName} (order ${m.orderId}): ${m.kind === 'missed_webhook' ? 'webhook never arrived' : `dropped by ${m.destination}`}, queued again`);
  await waitForQuiet('Replaying');
}

const v = await api<{ buyers: number; withAccess: number; duplicateAccounts: number; withOneWelcomeEmail: number; duplicateEmails: number; missing: string[] }>('/api/chaos/verify');
const s = await api<Stats>('/api/stats');
console.log('');
console.log(`Buyers with access:            ${v.withAccess} of ${v.buyers}`);
console.log(`Buyers with one welcome email: ${v.withOneWelcomeEmail} of ${v.buyers}`);
console.log(`Duplicate accounts:            ${v.duplicateAccounts}`);
console.log(`Duplicate emails:              ${v.duplicateEmails}`);
console.log(`Failed attempts retried:       ${s.failedAttempts}`);
console.log(`In dead letter queue:          ${s.deadLetter}`);
if (v.missing.length) console.log(`Still missing (see dead letter queue): ${v.missing.join(', ')}`);
