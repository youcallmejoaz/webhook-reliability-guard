import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestGuard, type TestGuard } from './helpers.js';
import { runChaos, ChaosLog } from '../src/mocks/runner.js';
import { reconcile } from '../src/reconcile.js';
import { ask } from '../src/incidents.js';
import { scrub, maskEmail } from '../src/mask.js';
import { backoffMs } from '../src/worker.js';

describe('incident explainer, masking and demo mode', () => {
  let g: TestGuard;
  beforeAll(async () => {
    g = await startTestGuard();
    g.ctx.mocks!.chaos.outages.set('email', Date.now() + 1_500);
    await runChaos(g.ctx, { buyers: 50, failRate: 0.2, dropRate: 0.05, seed: 7, intervalMs: 0 }, new ChaosLog());
    await g.worker.drain();
    await reconcile(g.ctx);
    await g.worker.drain();
    await g.ctx.incidents.settle();
  }, 90_000);
  afterAll(async () => {
    await g.close();
  });

  it('posts plain-English incidents to the mock Slack channel with no keys set', () => {
    const msgs = g.ctx.db.sql.prepare('SELECT title, text FROM slack_messages').all() as { title: string; text: string }[];
    expect(msgs.length).toBeGreaterThan(0);
    for (const m of msgs) {
      expect(m.text).toContain('*What happened*');
      expect(m.text).toContain('*Suggested fix*');
      expect(m.text).toContain('cannot change settings');
      expect(m.text).not.toMatch(/\{\{|\}\}/);
    }
  });

  it('never puts an email address or last name in Slack', () => {
    const buyers = g.ctx.mocks!.state.buyers();
    const all = (g.ctx.db.sql.prepare('SELECT title, text FROM slack_messages').all() as { title: string; text: string }[]).map((m) => `${m.title}\n${m.text}`).join('\n');
    expect(all).not.toMatch(/@/);
    for (const b of buyers) expect(all).not.toMatch(new RegExp(`\\b${b.last_name}\\b`));
  });

  it('answers "Why did the welcome emails fail last night?" from masked facts', async () => {
    const { answer, facts, model } = await ask(g.ctx, 'Why did the welcome emails fail last night?');
    expect(model).toContain('demo');
    expect(facts.destination).toBe('Email sender');
    expect(Number(facts.failed_attempts)).toBeGreaterThan(0);
    expect(answer).toContain('Email sender');
    expect(answer).toContain('DKIM');
    expect(answer).not.toMatch(/\{\{|@/);
    const buyers = g.ctx.mocks!.state.buyers();
    const factText = JSON.stringify(facts);
    for (const b of buyers) expect(factText).not.toContain(b.last_name);
  });

  it('scrubs emails and hidden words', () => {
    expect(scrub('contact ada.okafor1@example.com now')).toBe('contact [email hidden] now');
    expect(scrub('Ada Okafor paid', ['Okafor'])).toBe('Ada [hidden] paid');
    expect(maskEmail('ada.okafor1@example.com')).toBe('ad***@example.com');
  });

  it('backs off exponentially with a cap', () => {
    const fixed = () => 0.5;
    expect([1, 2, 3, 4, 10].map((n) => backoffMs(n, 1000, 8000, fixed))).toEqual([1000, 2000, 4000, 8000, 8000]);
  });
});
