// Renders the two Upwork cover options at 1600 x 1200, plus 1000 x 750 copies and 400 x 300 previews.
//   node docs/cover/render.mjs
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const docs = dirname(here);
const browser = await chromium.launch();
for (const v of ['a', 'b']) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
  await page.goto(pathToFileURL(join(here, `cover-${v}.html`)).href, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  const full = join(docs, `upwork-cover-${v}.png`);
  await page.screenshot({ path: full });
  for (const [w, h, suffix] of [[1000, 750, '1000x750'], [400, 300, 'preview-400x300']]) {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', full, '-vf', `scale=${w}:${h}:flags=lanczos`, join(docs, `upwork-cover-${v}-${suffix}.png`)]);
  }
  console.log(`rendered upwork-cover-${v}.png and its smaller copies`);
  await page.close();
}
await browser.close();
