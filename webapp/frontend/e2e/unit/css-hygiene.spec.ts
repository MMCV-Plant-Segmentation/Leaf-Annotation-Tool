// TDD hygiene guard — ACTIVATE at:  e2e/unit/css-hygiene.spec.ts
// Static scan of src/ enforcing: no ghost --color-* tokens, no raw color literals in .css.ts
// (outside the token source), and (Phase 2) no .module.css left. Browserless `unit` project.
import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
// After activation the spec lives in e2e/unit/, so SRC resolves to frontend/src — fix the relative
// depth on move: from e2e/unit/ it is ('..','..','src'). (Staged copy points at frontend/src too.)

function walk(dir: string, hit: (f: string) => void) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, hit);
    else hit(full);
  }
}
function files(pred: (f: string) => boolean): string[] {
  const out: string[] = [];
  walk(SRC, (f) => { if (pred(f)) out.push(f); });
  return out;
}

test('no ghost var(--color-*) tokens anywhere in src', () => {
  const offenders: string[] = [];
  for (const f of files((f) => /\.(css\.ts|module\.css|tsx?)$/.test(f))) {
    if (readFileSync(f, 'utf8').includes('var(--color-')) offenders.push(path.relative(SRC, f));
  }
  expect(offenders, `still reference non-existent --color-* tokens:\n${offenders.join('\n')}`).toEqual([]);
});

test('no raw hex / rgb() in .css.ts outside the token source', () => {
  const RAW = /#[0-9a-fA-F]{3,8}\b|\brgba?\(/;
  const offenders: string[] = [];
  for (const f of files((f) => f.endsWith('.css.ts') && !f.endsWith(path.join('theme', 'tokens.ts')))) {
    if (RAW.test(readFileSync(f, 'utf8'))) offenders.push(path.relative(SRC, f));
  }
  expect(offenders, `hard-code colors instead of using vars.*:\n${offenders.join('\n')}`).toEqual([]);
});

// Phase 2 complete — all .module.css files migrated to .css.ts.
test('no .module.css files remain (Phase 2 complete)', () => {
  const left = files((f) => f.endsWith('.module.css')).map((f) => path.relative(SRC, f));
  expect(left, `not yet migrated to Vanilla Extract:\n${left.join('\n')}`).toEqual([]);
});
