/**
 * Scope the legacy stylesheet under `.legacy` so its rules can't pollute Solid.
 *
 * Uses `postcss-prefixwrap` with a `:where(.legacy)` prefix: every legacy selector
 * is wrapped so the scope contributes ZERO specificity. Bare element selectors
 * become `:where(.legacy) button` (0,0,1) and class selectors `:where(.legacy) .foo`
 * (0,1,0), so Solid CSS-module classes always win — important because Solid mounts
 * *inside* the legacy scope and Kobalte portals render at `body.legacy`. Because the
 * prefix adds 0 specificity uniformly, the legacy stylesheet's own internal cascade
 * is preserved unchanged.
 *
 * Input:  webapp/static/style.css  (tokens stripped; legacy opinionated rules only)
 * Output: webapp/static/dist/legacy.css  (committed build artifact)
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import postcss from 'postcss';
import prefixwrap from 'postcss-prefixwrap';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts/ → frontend/ → webapp/ → code/
const codeRoot  = path.resolve(__dirname, '..', '..', '..');
const staticDir = path.resolve(codeRoot, 'webapp', 'static');
const distDir   = path.resolve(staticDir, 'dist');
const srcFile   = path.resolve(staticDir, 'style.css');
const outFile   = path.resolve(distDir, 'legacy.css');

mkdirSync(distDir, { recursive: true });
const src = readFileSync(srcFile, 'utf8');
const result = await postcss([prefixwrap(':where(.legacy)')]).process(src, { from: srcFile, to: outFile });
writeFileSync(outFile, result.css, 'utf8');
console.log('[build-legacy-css] →', outFile);
