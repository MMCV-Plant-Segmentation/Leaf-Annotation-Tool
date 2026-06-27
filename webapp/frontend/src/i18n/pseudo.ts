/**
 * Pseudo-locale generator. Transforms an English catalog into accented,
 * lengthened text that:
 *   1. proves the i18n system works end-to-end,
 *   2. makes any *unextracted* hard-coded string stick out (it stays plain ASCII),
 *   3. stress-tests layout with ~30% longer strings (feeds the reflow tests).
 *
 * Rules: same keys as the source, every value visibly differs, and any
 * `{placeholder}` tokens are preserved verbatim (never accented/expanded).
 */

import type { Catalog } from './catalog';

// Latin-1/extended accent map for ASCII letters.
const ACCENTS: Record<string, string> = {
  a: 'à', b: 'ƀ', c: 'ç', d: 'đ', e: 'é', f: 'ƒ', g: 'ĝ', h: 'ĥ', i: 'í',
  j: 'ĵ', k: 'ķ', l: 'ļ', m: 'ɱ', n: 'ñ', o: 'ó', p: 'þ', q: 'ɋ', r: 'ŕ',
  s: 'ŝ', t: 'ţ', u: 'ú', v: 'ʋ', w: 'ŵ', x: ' x', y: 'ý', z: 'ž',
  A: 'À', B: 'Ɓ', C: 'Ç', D: 'Đ', E: 'É', F: 'Ƒ', G: 'Ĝ', H: 'Ĥ', I: 'Í',
  J: 'Ĵ', K: 'Ķ', L: 'Ļ', M: 'Ṁ', N: 'Ñ', O: 'Ó', P: 'Þ', Q: 'Ɋ', R: 'Ŕ',
  S: 'Ŝ', T: 'Ţ', U: 'Ú', V: 'Ʋ', W: 'Ŵ', X: 'X', Y: 'Ý', Z: 'Ž',
};

/** Accent the letters of a plain text run, leaving punctuation/spaces as-is. */
function accent(text: string): string {
  let out = '';
  for (const ch of text) out += ACCENTS[ch] ?? ch;
  return out;
}

/**
 * Convert one English string to pseudo. Splits on `{placeholder}` tokens so the
 * tokens pass through untouched; accents and pads the literal runs around them.
 */
export function toPseudoString(value: string): string {
  const parts = value.split(/(\{\w+\})/g);
  const body = parts
    .map((part) => (/^\{\w+\}$/.test(part) ? part : accent(part)))
    .join('');
  // ~30% lengthening to stress layout; brackets make truncation obvious.
  const padLen = Math.max(1, Math.round(value.replace(/\{\w+\}/g, '').length * 0.3));
  const pad = '·'.repeat(padLen);
  return `[${body}${pad}]`;
}

/** Generate a full pseudo catalog from an English one (same keys). */
export function toPseudo(en: Catalog): Catalog {
  const out: Catalog = {};
  for (const [key, value] of Object.entries(en)) {
    out[key] = toPseudoString(value);
  }
  return out;
}
