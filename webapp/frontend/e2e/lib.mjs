// Minimal Puppeteer harness for driving the live app in a real browser.
// jsdom (Vitest) fakes layout/CSS — use this for anything visual: computed
// styles, canvas pixel size, overflow, real Kobalte state attributes.
//
// Requires a Chrome/Chromium binary. Override with PUPPETEER_EXEC if not at the
// default path. The app must already be running (`uv run app.py`, port 5000).
import puppeteer from 'puppeteer-core';

export const BASE = process.env.APP_URL || 'http://localhost:5000';
const EXEC = process.env.PUPPETEER_EXEC || '/usr/bin/google-chrome';
export const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Launch Chrome and return a page with the byline pre-seeded (skips the gate). */
export async function openApp({ user = 'ReproBot', deviceScaleFactor = 2 } = {}) {
  const browser = await puppeteer.launch({
    executablePath: EXEC,
    headless: 'new',
    args: ['--no-sandbox', '--window-size=1400,900'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor });
  await page.evaluateOnNewDocument((u) => localStorage.setItem('lesion-user', u), user);
  return { browser, page };
}

/** Load home and wait for window.availablePairs to populate (mirrors real entry). */
export async function gotoHome(page) {
  await page.goto(BASE + '/', { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => Array.isArray(window.availablePairs) && window.availablePairs.length > 0,
    { timeout: 8000 });
}

/** Client-side route change (no full reload — keeps window.availablePairs). */
export async function navigate(page, path) {
  await page.evaluate(p => window._navigate?.(p), path);
  await sleep(400);
}
