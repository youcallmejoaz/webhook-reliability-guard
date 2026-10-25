import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { checkBounces, checkDmarc, checkSpf, fixtureResolver, runEmailCheck, type TxtResolver } from '../src/emailcheck.js';

const resolverOf = (records: Record<string, string[]>): TxtResolver => ({
  async resolveTxt(name) {
    if (!records[name]) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    return records[name].map((r) => [r]);
  },
});

describe('email deliverability check', () => {
  it('reports the missing DKIM record and passes SPF and DMARC on the demo domain', async () => {
    process.env.DEMO_MODE = '1';
    const report = await runEmailCheck(loadConfig(), fixtureResolver(), { sent: 0, bounced: 0 });
    const by = Object.fromEntries(report.checks.map((c) => [c.name, c]));
    expect(by.SPF.status).toBe('pass');
    expect(by.DMARC.status).toBe('pass');
    expect(by.DKIM.status).toBe('fail');
    expect(by.DKIM.fix).toContain('s1._domainkey.demo-academy.example');
    expect(report.overall).toBe('fail');
    expect(report.summary).toContain('DKIM');
  });

  it('flags risky SPF and DMARC setups', async () => {
    expect((await checkSpf(resolverOf({ 'a.example': ['v=spf1 +all'] }), 'a.example')).status).toBe('warn');
    expect((await checkSpf(resolverOf({ 'a.example': ['v=spf1 -all', 'v=spf1 ~all'] }), 'a.example')).status).toBe('fail');
    expect((await checkSpf(resolverOf({}), 'a.example')).status).toBe('fail');
    expect((await checkDmarc(resolverOf({ '_dmarc.a.example': ['v=DMARC1; p=none'] }), 'a.example')).status).toBe('warn');
    expect((await checkDmarc(resolverOf({}), 'a.example')).status).toBe('fail');
  });

  it('turns bounce counts into a verdict', () => {
    expect(checkBounces(100, 0).status).toBe('pass');
    expect(checkBounces(100, 2).status).toBe('warn');
    expect(checkBounces(100, 8).status).toBe('fail');
  });
});
