// TDD acceptance for i18n — ACTIVATE at:  e2e/unit/i18n.spec.ts  (browserless `unit` project)
// Plain modules only:
//   src/i18n/catalog.ts  → setActiveCatalog(map), t(key, vars?)
//   src/i18n/pseudo.ts   → toPseudo(enCatalog)
import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setActiveCatalog, t } from '../../src/i18n/catalog';
import { toPseudo } from '../../src/i18n/pseudo';

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// On activation the spec is at e2e/unit/, so FRONTEND resolves to webapp/frontend either way.
const EN_PATH = path.resolve(FRONTEND, '..', 'static', 'i18n', 'en.json');

test.describe('catalog loader / fallback', () => {
  test.beforeAll(() => {
    setActiveCatalog({ 'greet.hello': 'Hello, {name}!', 'nav.home': 'Home' });
  });
  test('returns a known value', () => {
    expect(t('nav.home')).toBe('Home');
  });
  test('interpolates vars', () => {
    expect(t('greet.hello', { name: 'Christian' })).toBe('Hello, Christian!');
  });
  test('missing key falls back to the key, never empty, never throws', () => {
    expect(t('does.not.exist')).toBe('does.not.exist');
  });
});

test.describe('en.json catalog', () => {
  const en = (): Record<string, string> => JSON.parse(readFileSync(EN_PATH, 'utf8'));

  test('every t("literal") key used in src exists in en.json', () => {
    const cat = en();
    const used = new Set<string>();
    const walk = (dir: string) => {
      for (const n of readdirSync(dir)) {
        const f = path.join(dir, n);
        if (statSync(f).isDirectory()) { walk(f); continue; }
        if (!/\.tsx?$/.test(f)) continue;
        const src = readFileSync(f, 'utf8');
        for (const m of src.matchAll(/\bt\(\s*['"]([^'"]+)['"]/g)) used.add(m[1]);
      }
    };
    walk(path.resolve(FRONTEND, 'src'));
    const missing = [...used].filter((k) => !(k in cat));
    expect(missing, `keys used in code but absent from en.json:\n${missing.join('\n')}`).toEqual([]);
  });

  test('no empty values in en.json', () => {
    const empties = Object.entries(en()).filter(([, v]) => !v || !v.trim()).map(([k]) => k);
    expect(empties, `empty catalog values:\n${empties.join('\n')}`).toEqual([]);
  });
});

test.describe('pseudo-locale', () => {
  const en = { 'a.b': 'Start Training', 'c.d': 'Hello, {name}!' };
  test('same keys as English', () => {
    expect(Object.keys(toPseudo(en)).sort()).toEqual(Object.keys(en).sort());
  });
  test('values differ from English (would surface unextracted strings)', () => {
    expect(toPseudo(en)['a.b']).not.toBe(en['a.b']);
  });
  test('preserves {placeholders} verbatim', () => {
    expect(toPseudo(en)['c.d']).toContain('{name}');
  });
});
