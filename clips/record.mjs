// Records every clip in the shot list from the app running in demo mode.
//   npm run clips            (needs ffmpeg on PATH and Playwright with Chromium)
//
// Frames come from Chrome's screencast (sharp JPEG frames with timestamps) rather than
// Playwright's built-in video, which is too soft for small dashboard text. Each clip is cut
// from those frames by timestamp and encoded to H.264, yuv420p, 30 fps with ffmpeg.

import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const CLIPS = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(CLIPS);
const STILLS = join(CLIPS, 'stills');
const PORT = 3210;
const BASE = `http://localhost:${PORT}`;
const VIEW = { width: 1920, height: 1080 };
const ONLY = process.argv.slice(2); // optional list of clip ids to record
const want = (id) => ONLY.length === 0 || ONLY.includes(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now() / 1000;

mkdirSync(STILLS, { recursive: true });

// ---------- app ----------
const dataDir = mkdtempSync(join(tmpdir(), 'guard-clips-'));
const server = spawn('npx', ['tsx', 'src/server.ts'], {
  cwd: ROOT,
  env: {
    ...process.env,
    DEMO_MODE: '1',
    ANTHROPIC_API_KEY: '',
    PORT: String(PORT),
    BASE_URL: BASE,
    DATA_DIR: dataDir,
    DB_PATH: join(dataDir, 'guard.db'),
    BACKOFF_BASE_MS: '900',
    NODE_OPTIONS: '--disable-warning=ExperimentalWarning',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
  detached: true, // own process group, so the whole tree stops at the end
});
const stopServer = () => {
  try {
    process.kill(-server.pid, 'SIGTERM');
  } catch {}
};
process.on('exit', stopServer);
const api = async (path, body) => {
  const res = await fetch(`${BASE}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
};
for (let i = 0; ; i++) {
  try {
    if ((await fetch(`${BASE}/health`)).ok) break;
  } catch {}
  if (i > 60) throw new Error('server did not start');
  await sleep(500);
}

// ---------- cursor and click ring ----------
const CURSOR = `(() => {
  const add = () => {
    if (document.getElementById('__cur')) return;
    const c = document.createElement('div');
    c.id = '__cur';
    c.innerHTML = '<svg width="30" height="36" viewBox="0 0 17 20"><path d="M1.5 1.5 L1.5 16 L5.3 12.4 L8.2 18.8 L11 17.6 L8.2 11.3 L13.6 11.3 Z" fill="#0f172a" stroke="#ffffff" stroke-width="1.3" stroke-linejoin="round"/></svg>';
    Object.assign(c.style, { position: 'fixed', left: '-100px', top: '-100px', zIndex: 2147483647, pointerEvents: 'none', filter: 'drop-shadow(0 2px 3px rgba(0,0,0,.35))' });
    document.body.appendChild(c);
    addEventListener('mousemove', (e) => { c.style.left = (e.clientX - 2) + 'px'; c.style.top = (e.clientY - 2) + 'px'; }, true);
    addEventListener('mousedown', (e) => {
      const r = document.createElement('div');
      Object.assign(r.style, { position: 'fixed', left: (e.clientX - 30) + 'px', top: (e.clientY - 30) + 'px', width: '60px', height: '60px', borderRadius: '50%', border: '4px solid #f59e0b', background: 'rgba(245,158,11,.2)', zIndex: 2147483646, pointerEvents: 'none', transition: 'transform .55s ease, opacity .55s ease' });
      document.body.appendChild(r);
      requestAnimationFrame(() => requestAnimationFrame(() => { r.style.transform = 'scale(1.7)'; r.style.opacity = '0'; }));
      setTimeout(() => r.remove(), 700);
    }, true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add); else add();
})();`;

const mouse = new WeakMap();
async function glide(page, x, y, ms = 700) {
  const from = mouse.get(page) ?? { x: 960, y: 640 };
  const steps = Math.max(8, Math.round(ms / 16));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    await page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
    await sleep(16);
  }
  mouse.set(page, { x, y });
}
async function center(page, selector) {
  // The dashboard re-renders on every poll, so an element can detach mid-measure: retry briefly.
  let box = null;
  for (let i = 0; i < 20 && !box; i++) {
    box = await page.locator(selector).first().boundingBox({ timeout: 1000 }).catch(() => null);
    if (!box) await sleep(100);
  }
  if (!box) throw new Error(`not visible: ${selector}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
}
async function click(page, selector, after = 800) {
  const { x, y } = await center(page, selector);
  await glide(page, x, y);
  await sleep(250);
  await page.mouse.down();
  await sleep(90);
  await page.mouse.up();
  await sleep(after);
}
async function hover(page, selector, after = 700) {
  const { x, y } = await center(page, selector);
  await glide(page, x, y, 800);
  await sleep(after);
}

// ---------- capture ----------
async function openPage(browser, { cursor = true } = {}) {
  const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1 });
  if (cursor) await context.addInitScript(CURSOR);
  const page = await context.newPage();
  return { context, page };
}

async function capture(page) {
  const cdp = await page.context().newCDPSession(page);
  const dir = mkdtempSync(join(tmpdir(), 'frames-'));
  const frames = [];
  let n = 0;
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    const file = join(dir, `${String(n++).padStart(6, '0')}.jpg`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    frames.push({ file, t: metadata.timestamp });
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: VIEW.width, maxHeight: VIEW.height, everyNthFrame: 1 });
  return {
    frames,
    async stop() {
      await cdp.send('Page.stopScreencast').catch(() => {});
      await sleep(200);
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Writes clips/<name>.mp4 from the frames between two timestamps (seconds since epoch).
function encode(frames, start, end, name, crop = null) {
  const sel = frames.filter((f) => f.t >= start && f.t <= end);
  const before = frames.filter((f) => f.t < start).at(-1);
  if (before) sel.unshift({ ...before, t: start });
  if (sel.length === 0) throw new Error(`no frames for ${name}`);
  const lines = [];
  sel.forEach((f, i) => {
    const next = i + 1 < sel.length ? sel[i + 1].t : end;
    lines.push(`file '${f.file}'`, `duration ${Math.max(0.001, next - f.t).toFixed(4)}`);
  });
  lines.push(`file '${sel.at(-1).file}'`);
  const list = join(tmpdir(), `${name}.txt`);
  writeFileSync(list, lines.join('\n'));
  const filters = [];
  if (crop) filters.push(`crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`, 'scale=1920:1080:flags=lanczos');
  else filters.push('scale=1920:1080:flags=lanczos');
  filters.push('fps=30', 'format=yuv420p');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-vf', filters.join(','), '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-movflags', '+faststart', '-an', '-t', (end - start).toFixed(3), join(CLIPS, `${name}.mp4`)]);
  rmSync(list);
  console.log(`  wrote clips/${name}.mp4 (${(end - start).toFixed(1)} s)`);
}

// A 16:9 crop rectangle around a box, with padding, kept inside the frame.
function cropAround(box, pad = 60) {
  let w = box.width + pad * 2;
  let h = box.height + pad * 2;
  if (w / h > 16 / 9) h = (w * 9) / 16;
  else w = (h * 16) / 9;
  w = Math.min(1920, Math.round(w / 2) * 2);
  h = Math.min(1080, Math.round(h / 2) * 2);
  const x = Math.round(Math.min(Math.max(0, box.x + box.width / 2 - w / 2), 1920 - w));
  const y = Math.round(Math.min(Math.max(0, box.y + box.height / 2 - h / 2), 1080 - h));
  return { w, h, x, y };
}

async function waitFor(cond, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await sleep(250);
  }
  throw new Error('timed out waiting');
}

const browser = await chromium.launch();

try {
  // ---------- explainer cards ----------
  const cards = [
    ['K01', 'K01_problem', 6.5],
    ['K02', 'K02_flow', 8],
    ['K03', 'K03_safeguards', 7],
    ['K04', 'K04_offer', 7],
  ];
  for (const [id, name, seconds] of cards) {
    if (!want(id)) continue;
    console.log(`Recording ${id}`);
    const { context, page } = await openPage(browser, { cursor: false });
    const cap = await capture(page);
    const start = now();
    await page.goto(pathToFileURL(join(CLIPS, 'cards', `${id}.html`)).href);
    await sleep(seconds * 1000);
    await page.screenshot({ path: join(CLIPS, 'cards', `${id}.png`) });
    const end = now();
    await cap.stop();
    encode(cap.frames, start + 0.15, end, name);
    cap.cleanup();
    await context.close();
  }

  // ---------- P01: the build prompt ----------
  if (want('P01')) {
    console.log('Recording P01');
    const { context, page } = await openPage(browser, { cursor: false });
    await page.goto(pathToFileURL(join(CLIPS, 'cards', 'prompt.html')).href);
    await sleep(300);
    const cap = await capture(page);
    const start = now();
    await page.evaluate((d) => window.play(d), {
      prompt: 'Build a safety net for our automations: catch every webhook from the store, retry failures, check nothing was missed, and explain problems in plain English.',
      cps: 24,
      working: 'Planning',
      lineDelay: 160,
      lines: [
        { text: 'Plan', cls: 'h' },
        { text: '1. Receiver: signed webhooks, every event saved before replying' },
        { text: '2. Delivery: membership site, email sender, n8n, with retries' },
        { text: '3. Dead letter queue after the retry limit, one-click replay' },
        { text: '4. Every 15 minutes: compare store purchases with each tool' },
        { text: '5. Email check: SPF, DKIM, DMARC and bounces' },
        { text: '6. Claude explains repeated failures in Slack (read only, masked)' },
        { text: '7. Buyer list synced to Google Sheets' },
        { text: '8. Dashboard, demo mode with mock tools, tests under 20% failures' },
      ],
    });
    await waitFor(() => page.evaluate(() => window.done === true));
    await sleep(1800);
    const end = now();
    await cap.stop();
    encode(cap.frames, start, end, 'P01_build_prompt');
    await page.screenshot({ path: join(STILLS, 'P01.png') });
    cap.cleanup();
    await context.close();
  }

  // ---------- C01 to C03: the chaos run, one continuous recording cut into three ----------
  const live = ['C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'P02'].some(want);
  if (live) {
    await api('/api/demo/reset', {});
    console.log('Recording C01 to C03');
    const { context, page } = await openPage(browser);
    await page.goto(`${BASE}/?outage=email:9#overview`);
    await page.waitForSelector('#chaos-start');
    await page.mouse.move(960, 640);
    mouse.set(page, { x: 960, y: 640 });
    await sleep(400);
    const cap = await capture(page);
    const c01 = now();
    await sleep(800);
    await click(page, '#chaos-start', 400);
    await sleep(6400);
    const c02 = now();
    await hover(page, '.ev.s-retry .d.retry', 1600);
    await page.screenshot({ path: join(STILLS, 'C02.png') });
    await hover(page, '#t-retrying', 2600);
    await hover(page, '.ev.s-retry', 2200);
    const c02end = now();
    await waitFor(async () => (await api('/api/stats')).inProgress === 0, 90_000);
    await hover(page, '#t-delivered', 2400);
    const c03end = now();
    await page.screenshot({ path: join(STILLS, 'C03.png') });
    await cap.stop();
    encode(cap.frames, c01, c02, 'C01_chaos_start');
    encode(cap.frames, c02, c02end, 'C02_failures_retrying');
    encode(cap.frames, Math.max(c02end, c03end - 8.5), c03end, 'C03_retries_succeed');
    cap.cleanup();
    await context.close();
  }

  // ---------- C04: reconciliation ----------
  if (live) {
    await sleep(3500); // past the reconciliation grace period
    console.log('Recording C04');
    const { context, page } = await openPage(browser);
    await page.goto(`${BASE}/#overview`);
    await page.waitForSelector('.ev');
    mouse.set(page, { x: 1300, y: 700 });
    await page.mouse.move(1300, 700);
    await sleep(800);
    const cap = await capture(page);
    const start = now();
    await hover(page, '#t-misses', 900);
    await click(page, '[data-tab=recon]', 700);
    await click(page, '#recon-run', 2600);
    await page.screenshot({ path: join(STILLS, 'C04.png') });
    await hover(page, '#miss-table tbody tr:nth-child(2)', 1000);
    await hover(page, '#t-misses', 1300);
    const end = now();
    await cap.stop();
    encode(cap.frames, start, end, 'C04_reconciliation');
    cap.cleanup();
    await context.close();

    // A clean still of the dashboard after the chaos test, for the cover image.
    await waitFor(async () => (await api('/api/stats')).inProgress === 0, 60_000);
    const still = await openPage(browser, { cursor: false });
    await still.page.goto(`${BASE}/#overview`);
    await still.page.waitForSelector('.ev');
    await sleep(1500);
    await still.page.screenshot({ path: join(STILLS, 'dashboard_after_chaos.png') });
    await still.context.close();
  }

  // ---------- C05: dead letter queue and replay, full and close up ----------
  if (live && (await api('/api/stats')).deadLetter === 0) console.log('Skipping C05: nothing landed in the dead letter queue this run');
  else if (live) {
    await api('/api/chaos/stop', {}); // the email sender is back up
    console.log('Recording C05');
    const { context, page } = await openPage(browser);
    await page.goto(`${BASE}/#dead`);
    await page.waitForSelector('#dead-table .replay');
    mouse.set(page, { x: 1100, y: 760 });
    await page.mouse.move(1100, 760);
    await sleep(800);
    // Close up: a 1.5x zoom on the error, time and Replay columns of the top rows.
    const table = (await center(page, '#dead-table')).box;
    const right = Math.min(1920, Math.round(table.x + table.width + 24));
    const closeCrop = { w: 1280, h: 720, x: right - 1280, y: Math.max(0, Math.round(table.y - 120)) };
    const cap = await capture(page);
    const start = now();
    await sleep(500);
    await page.screenshot({ path: join(STILLS, 'C05.png') });
    await click(page, '#dead-table tbody tr:nth-child(1) .replay', 1400);
    await click(page, '#dead-table tbody tr:not(.leaving) .replay', 1600);
    const end = now();
    await cap.stop();
    encode(cap.frames, start, end, 'C05_dead_letter_replay');
    encode(cap.frames, start, end, 'C05_dead_letter_replay_close', closeCrop);
    cap.cleanup();
    await context.close();
    await api('/api/dead-letter/replay-all', {});
  }

  // ---------- C06: Slack explanation ----------
  if (live) {
    console.log('Recording C06');
    const { context, page } = await openPage(browser);
    await page.goto(`${BASE}/#slack`);
    await page.waitForSelector('.msg');
    await page.evaluate(() => (document.querySelector('#slack-feed').scrollTop = 0));
    mouse.set(page, { x: 1200, y: 600 });
    await page.mouse.move(1200, 600);
    await sleep(800);
    const cap = await capture(page);
    const start = now();
    await hover(page, '.msg:nth-child(1) .title', 1200);
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          const feed = document.querySelector('#slack-feed');
          const from = feed.scrollTop;
          const to = feed.scrollHeight - feed.clientHeight;
          const t0 = performance.now();
          const step = (t) => {
            const p = Math.min(1, (t - t0) / 6500);
            feed.scrollTop = from + (to - from) * (p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2);
            if (p < 1) requestAnimationFrame(step);
            else resolve();
          };
          requestAnimationFrame(step);
        }),
    );
    await page.screenshot({ path: join(STILLS, 'C06.png') });
    await sleep(1500);
    const end = now();
    await cap.stop();
    encode(cap.frames, start, end, 'C06_slack_explainer');
    cap.cleanup();
    await context.close();
  }

  // ---------- C07: email check ----------
  if (live) {
    console.log('Recording C07');
    const { context, page } = await openPage(browser);
    await page.goto(`${BASE}/#overview`);
    await page.waitForSelector('.ev');
    mouse.set(page, { x: 900, y: 500 });
    await page.mouse.move(900, 500);
    await sleep(800);
    const cap = await capture(page);
    const start = now();
    await click(page, '[data-tab=email]', 1200);
    await hover(page, '.check.pass h3', 1100);
    await hover(page, '.check.fail .fix', 2600);
    await page.screenshot({ path: join(STILLS, 'C07.png') });
    await hover(page, '.check.pass:nth-of-type(3) h3', 1200);
    const end = now();
    await cap.stop();
    encode(cap.frames, start, end, 'C07_email_check');
    cap.cleanup();
    await context.close();
  }

  // ---------- C08: buyer list sheet updates ----------
  if (live) {
    console.log('Recording C08');
    const { context, page } = await openPage(browser);
    await page.goto(`${BASE}/#buyers`);
    await page.waitForSelector('#sheet tbody tr');
    mouse.set(page, { x: 1300, y: 520 });
    await page.mouse.move(1300, 520);
    await sleep(1200);
    const cap = await capture(page);
    const start = now();
    const sending = api('/api/demo/purchases', { count: 3, intervalMs: 1100 });
    await hover(page, '#sheet tbody tr:nth-child(1)', 2600);
    await sending;
    await sleep(1200);
    await page.screenshot({ path: join(STILLS, 'C08.png') });
    await hover(page, '#sheet-sync', 1200);
    const end = now();
    await cap.stop();
    encode(cap.frames, start, end, 'C08_buyer_list');
    cap.cleanup();
    await context.close();
  }

  // ---------- P02: "Why did the welcome emails fail last night?" ----------
  if (live) {
    console.log('Recording P02');
    const question = 'Why did the welcome emails fail last night?';
    const { answer } = await api('/api/ask', { question });
    const { context, page } = await openPage(browser, { cursor: false });
    await page.goto(pathToFileURL(join(CLIPS, 'cards', 'prompt.html')).href);
    await sleep(300);
    const cap = await capture(page);
    const start = now();
    const sentences = answer.split(/(?<=\.)\s+/).map((s) => s.trim()).filter(Boolean);
    await page.evaluate((d) => window.play(d), {
      prompt: question,
      cps: 12,
      working: 'Reading the event log',
      lineDelay: 380,
      lines: sentences.map((text) => ({ text })),
    });
    await waitFor(() => page.evaluate(() => window.done === true));
    await sleep(2200);
    const end = now();
    await cap.stop();
    encode(cap.frames, start, end, 'P02_why_emails_failed');
    await page.screenshot({ path: join(STILLS, 'P02.png') });
    cap.cleanup();
    await context.close();
  }
} finally {
  await browser.close();
  stopServer();
  if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
}
