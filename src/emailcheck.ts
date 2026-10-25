import { promises as dns } from 'node:dns';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.js';

// Checks the three DNS records that decide whether login and welcome emails land in the inbox,
// and reads the send log for bounces. Every result comes with a plain-English verdict and,
// when something is wrong, the exact record to add.

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface CheckResult {
  name: 'SPF' | 'DKIM' | 'DMARC' | 'Bounces';
  status: CheckStatus;
  record: string | null;
  verdict: string;
  fix: string | null;
}

export interface EmailCheckReport {
  domain: string;
  checkedAt: number;
  overall: CheckStatus;
  summary: string;
  checks: CheckResult[];
}

export interface TxtResolver {
  resolveTxt(name: string): Promise<string[][]>;
}

export function fixtureResolver(path = join(import.meta.dirname, '..', 'fixtures', 'dns.json')): TxtResolver {
  const records = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string[]>;
  return {
    async resolveTxt(name) {
      const found = records[name.toLowerCase()];
      if (!found) throw Object.assign(new Error(`queryTxt ENOTFOUND ${name}`), { code: 'ENOTFOUND' });
      return found.map((r) => [r]);
    },
  };
}

export const systemResolver: TxtResolver = { resolveTxt: (name) => dns.resolveTxt(name) };

async function txt(resolver: TxtResolver, name: string): Promise<string[]> {
  try {
    return (await resolver.resolveTxt(name)).map((chunks) => chunks.join(''));
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOTFOUND' || code === 'ENODATA') return [];
    throw err;
  }
}

export async function checkSpf(resolver: TxtResolver, domain: string): Promise<CheckResult> {
  const spf = (await txt(resolver, domain)).filter((r) => r.toLowerCase().startsWith('v=spf1'));
  if (spf.length === 0) {
    return { name: 'SPF', status: 'fail', record: null, verdict: 'No SPF record. Inboxes cannot tell which servers may send email for your domain.', fix: `Add a TXT record on ${domain} with the value your email provider gives you, for example: v=spf1 include:<your provider> ~all` };
  }
  if (spf.length > 1) {
    return { name: 'SPF', status: 'fail', record: spf.join(' | '), verdict: 'There are two SPF records. Inboxes treat that as no SPF at all.', fix: `Merge them into one TXT record on ${domain}.` };
  }
  const record = spf[0];
  if (/[+?]all\b/.test(record)) {
    return { name: 'SPF', status: 'warn', record, verdict: 'SPF exists but allows any server to send as you.', fix: `Change the end of the record on ${domain} to ~all or -all.` };
  }
  return { name: 'SPF', status: 'pass', record, verdict: 'SPF is set up. Inboxes know which servers may send for you.', fix: null };
}

export async function checkDkim(resolver: TxtResolver, domain: string, selectors: string[]): Promise<CheckResult> {
  for (const selector of selectors) {
    const name = `${selector}._domainkey.${domain}`;
    const record = (await txt(resolver, name)).find((r) => /v=DKIM1/i.test(r) && /p=[A-Za-z0-9+/=]{20,}/.test(r));
    if (record) return { name: 'DKIM', status: 'pass', record, verdict: `DKIM is set up (selector "${selector}"). Your emails carry a valid signature.`, fix: null };
  }
  const name = `${selectors[0]}._domainkey.${domain}`;
  return {
    name: 'DKIM',
    status: 'fail',
    record: null,
    verdict: 'DKIM is missing. Your emails are not signed, so many inboxes send them to spam or reject them.',
    fix: `Add a TXT record named ${name} with the DKIM public key from your email sending service (it starts with v=DKIM1; k=rsa; p=). Then run this check again.`,
  };
}

export async function checkDmarc(resolver: TxtResolver, domain: string): Promise<CheckResult> {
  const record = (await txt(resolver, `_dmarc.${domain}`)).find((r) => r.toUpperCase().startsWith('V=DMARC1'));
  if (!record) {
    return { name: 'DMARC', status: 'fail', record: null, verdict: 'No DMARC policy. Inboxes do not know what to do with emails that fail SPF or DKIM.', fix: `Add a TXT record named _dmarc.${domain} with: v=DMARC1; p=quarantine; pct=100` };
  }
  const policy = /p=(\w+)/i.exec(record)?.[1]?.toLowerCase();
  if (policy === 'none') {
    return { name: 'DMARC', status: 'warn', record, verdict: 'DMARC is in monitoring mode only (p=none). It reports problems but does not protect you.', fix: `When reports look clean, change p=none to p=quarantine on _dmarc.${domain}.` };
  }
  return { name: 'DMARC', status: 'pass', record, verdict: `DMARC is set to ${policy}. Fake emails using your domain get blocked.`, fix: null };
}

export function checkBounces(sent: number, bounced: number): CheckResult {
  const rate = sent === 0 ? 0 : bounced / sent;
  const pct = `${(rate * 100).toFixed(1)}%`;
  if (sent === 0) return { name: 'Bounces', status: 'pass', record: null, verdict: 'No emails sent in the last 24 hours yet.', fix: null };
  if (rate >= 0.05) return { name: 'Bounces', status: 'fail', record: `${bounced} of ${sent}`, verdict: `${pct} of emails bounced. Above 5% the email provider may pause your account.`, fix: 'Check the bounced addresses with those buyers and fix typos at checkout.' };
  if (bounced > 0) return { name: 'Bounces', status: 'warn', record: `${bounced} of ${sent}`, verdict: `${bounced} of ${sent} emails bounced (${pct}). Usually a typo in the address at checkout.`, fix: 'Contact those buyers another way and correct their address.' };
  return { name: 'Bounces', status: 'pass', record: `0 of ${sent}`, verdict: 'No bounces.', fix: null };
}

export async function runEmailCheck(config: Config, resolver: TxtResolver, bounceLog: { sent: number; bounced: number }): Promise<EmailCheckReport> {
  const domain = config.emailDomain;
  const checks = [
    await checkSpf(resolver, domain),
    await checkDkim(resolver, domain, config.dkimSelectors),
    await checkDmarc(resolver, domain),
    checkBounces(bounceLog.sent, bounceLog.bounced),
  ];
  const overall: CheckStatus = checks.some((c) => c.status === 'fail') ? 'fail' : checks.some((c) => c.status === 'warn') ? 'warn' : 'pass';
  const failing = checks.filter((c) => c.status === 'fail').map((c) => c.name);
  const summary =
    overall === 'pass'
      ? `Email setup for ${domain} looks healthy.`
      : failing.length
        ? `${failing.join(' and ')} need${failing.length === 1 ? 's' : ''} fixing on ${domain}. Until then some login and welcome emails may land in spam.`
        : `Email setup for ${domain} works, with ${checks.filter((c) => c.status === 'warn').length} thing(s) worth tidying up.`;
  return { domain, checkedAt: Date.now(), overall, summary, checks };
}
