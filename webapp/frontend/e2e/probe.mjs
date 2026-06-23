// Visual/behavioral probe for the analyze viewer. Drives the real home→analyze
// path, launches the viewer, and reports canvas backing-store resolution vs CSS
// size (the resolution bug), plus a screenshot. Extend freely for future debugging.
//
//   uv run --no-project node e2e/probe.mjs
import { openApp, gotoHome, navigate, sleep, BASE } from './lib.mjs';

const OUT = process.env.SHOT_DIR || '/tmp';
const { browser, page } = await openApp();
const log = (...a) => console.log(...a);

await gotoHome(page);
await navigate(page, '/analyze');                       // SPA nav: picker sees availablePairs

// pick the first merged/reannotated option, then launch the viewer
const opt = await page.$('[role="option"]');
if (!opt) { log('No analyze options — check window.availablePairs / eligibility'); await browser.close(); process.exit(1); }
await opt.click();
await sleep(250);
await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find(x => /analyz/i.test(x.textContent || ''));
  b?.click();
});
await sleep(1500);  // image load + first draw

const r = await page.evaluate(() => {
  const cv = document.getElementById('analyze-canvas');
  if (!cv) return { error: 'no #analyze-canvas' };
  const rect = cv.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const main = document.getElementById('analyze-main');
  return {
    devicePixelRatio: dpr,
    cssSize:     { w: Math.round(rect.width), h: Math.round(rect.height) },
    backingStore:{ w: cv.width, h: cv.height },
    expectedBacking: { w: Math.round(rect.width * dpr), h: Math.round(rect.height * dpr) },
    backingMatchesDpr: cv.width === Math.round(rect.width * dpr),
    devicePixelsPerCssPixel: +(cv.width / (rect.width || 1)).toFixed(3),
    containerVisible: main ? getComputedStyle(main).display !== 'none' : 'no-el',
  };
});
log('[CANVAS RESOLUTION]', JSON.stringify(r, null, 2));
await page.screenshot({ path: `${OUT}/probe_viewer.png` });
log('screenshot:', `${OUT}/probe_viewer.png`);

await browser.close();
