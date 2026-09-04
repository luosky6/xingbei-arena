// UI visual/DOM baseline. This opens the read-only engine and captures the
// current page without starting a match; use it before/after theme changes.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, PORT } from './server.mjs';
import { browserLaunchOptions } from './browser.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const runtime = join(here, '..', 'runtime');
const modern = !!process.env.XB_MODERN_UI;
const mode = modern ? 'modern' : 'legacy';
const outputDir = join(runtime, 'ui-screenshots');
const pngPath = process.env.XB_UI_SCREENSHOT || join(outputDir, `${mode}.png`);
const jsonPath = process.env.XB_UI_BASELINE || join(outputDir, `${mode}.json`);
const waitMs = Number(process.env.XB_UI_WAIT || 5000);

const server = await startServer();
const browser = await chromium.launch(browserLaunchOptions({ headless: process.env.XB_HEADFUL ? false : true }));
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
if (modern) await page.addInitScript(() => {
  const attempt = async () => { try { const mod = await import('/__arena/ui-overlay/install.js'); await mod.installModernTheme?.({ policyId: 'ui-baseline' }); } catch { setTimeout(attempt, 250); } };
  attempt();
});
try {
  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(waitMs);
  await mkdir(outputDir, { recursive: true });
  await page.screenshot({ path: pngPath, fullPage: true });
  const baseline = await page.evaluate(() => ({
    schema_version: 'ui-baseline.v1',
    title: document.title,
    viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
    body_class: document.body?.className || '',
    modern_theme: document.documentElement?.dataset?.xbModernTheme === '1',
    element_counts: { players: document.querySelectorAll('.player').length, cards: document.querySelectorAll('.card').length, dialogs: document.querySelectorAll('.dialog').length, controls: document.querySelectorAll('.control').length },
    visible_text_prefix: (document.body?.innerText || '').slice(0, 1000),
  }));
  baseline.mode = mode;
  baseline.screenshot = pngPath;
  await writeFile(jsonPath, JSON.stringify(baseline, null, 2) + '\n');
  console.log(JSON.stringify(baseline, null, 2));
} finally {
  await Promise.race([browser.close(), new Promise(resolve => setTimeout(resolve, 5000))]);
  server.close();
}
