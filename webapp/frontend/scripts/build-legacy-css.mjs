/**
 * Scope style.css to .legacy containers so legacy rules don't pollute Solid.
 *
 * Bare element selectors (button, select, canvas, header, main …) are wrapped
 * with :where(.legacy) — keeping their specificity at 0,0,1 so Solid module
 * classes (0,1,0) always win.  Everything else gets a plain .legacy prefix.
 *
 * Input:  webapp/static/style.css  (tokens stripped; only opinionated legacy rules)
 * Output: webapp/static/dist/legacy.css  (committed build artifact)
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import postcss from 'postcss';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts/ → frontend/ → webapp/ → code/
const codeRoot = path.resolve(__dirname, '..', '..', '..');
const staticDir = path.resolve(codeRoot, 'webapp', 'static');
const distDir   = path.resolve(staticDir, 'dist');
const srcFile   = path.resolve(staticDir, 'style.css');
const outFile   = path.resolve(distDir, 'legacy.css');

function splitSelectors(sel) {
  const parts = [];
  let depth = 0, cur = '';
  for (const ch of sel) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function isBarElement(part) {
  const t = part.trim();
  if (!t || !/^[a-zA-Z]/.test(t)) return false;
  const m = t.match(/^([^ >+~\t\n\r]+)/);
  const first = m ? m[1] : t;
  return !/[.#[]/.test(first);
}

function scopeSelector(sel) {
  return splitSelectors(sel)
    .map(p => isBarElement(p) ? `:where(.legacy) ${p}` : `.legacy ${p}`)
    .join(', ');
}

const plugin = () => ({ postcssPlugin: 'scope-legacy', Rule(r) { r.selector = scopeSelector(r.selector); } });
plugin.postcss = true;

mkdirSync(distDir, { recursive: true });
const src = readFileSync(srcFile, 'utf8');
const result = await postcss([plugin()]).process(src, { from: srcFile, to: outFile });
writeFileSync(outFile, result.css, 'utf8');
console.log('[build-legacy-css] →', outFile);
