// TDD red→green driver for the 200-line limit — ACTIVATE at:  e2e/unit/file-size.spec.ts
// Mirrors the ESLint `max-lines` guard (raw lines). The ESLint rule is the ongoing enforcement;
// this spec gives a clear list of offenders to refactor. Browserless `unit` project.
import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const LIMIT = 200;

test('no source file exceeds 200 raw lines', () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const n of readdirSync(dir)) {
      const f = path.join(dir, n);
      if (statSync(f).isDirectory()) { walk(f); continue; }
      if (!/\.(tsx?|css\.ts)$/.test(f) || f.endsWith('.d.ts')) continue;
      const lines = readFileSync(f, 'utf8').split('\n').length;
      if (lines > LIMIT) offenders.push(`${path.relative(SRC, f)} (${lines})`);
    }
  };
  walk(SRC);
  expect(offenders, `files over ${LIMIT} lines — split them:\n${offenders.join('\n')}`).toEqual([]);
});
