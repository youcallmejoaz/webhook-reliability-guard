import type { Ctx } from './context.js';
import { scrub } from './mask.js';

// Every alert is stored locally (the dashboard shows it as a Slack channel). When a real
// Slack incoming webhook is configured and demo mode is off, it is also posted there.
export async function postSlack(ctx: Ctx, title: string, text: string): Promise<void> {
  const safeTitle = scrub(title);
  const safeText = scrub(text);
  ctx.db.sql.prepare('INSERT INTO slack_messages (channel, at, title, text) VALUES (?, ?, ?, ?)').run(ctx.config.slackChannel, Date.now(), safeTitle, safeText);
  if (ctx.config.demoMode || !ctx.config.slackWebhookUrl) return;
  try {
    await fetch(ctx.config.slackWebhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `*${safeTitle}*\n${safeText}` }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.error('could not post to Slack:', (err as Error).message);
  }
}
