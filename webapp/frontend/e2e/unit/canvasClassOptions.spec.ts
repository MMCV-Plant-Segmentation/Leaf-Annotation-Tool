/**
 * Unit tests for buildClassOptions (t109 — broken/orphaned labels in the annotator).
 * The paint dropdown's option list is the VALID compound palette PLUS every broken
 * (INVALID / orphaned) compound folded in AFTER it, flagged `broken: true` so the picker
 * can mark it — but still a real, paintable option (resolution matches by name against the
 * full compound list). Contract: valid options are passed through untouched; broken ones
 * are appended, flagged, and given a continuing `order`; ids/names/colours are preserved.
 */
import { test, expect } from '@playwright/test';
import { buildClassOptions } from '../../src/projects/canvasClassOptions';
import type { Label } from '../../src/projects/api';
import type { BrokenCompound } from '../../src/projects/taxonomy';

const valid: Label[] = [
  { id: 'c1', name: 'lesion', color: '#111', order: 0 },
  { id: 'c2', name: 'midrib', color: '#222', order: 1 },
];
const broken: BrokenCompound[] = [
  { id: 'b1', name: 'legacy', color: '#333' },
  { id: 'b2', name: 'orphan', color: '#444' },
];

test('valid options pass through untouched, no broken flag', () => {
  const out = buildClassOptions(valid, []);
  expect(out).toEqual(valid);
  expect(out.some((o) => o.broken)).toBe(false);
});

test('broken compounds are appended after the valid palette', () => {
  const out = buildClassOptions(valid, broken);
  expect(out.map((o) => o.id)).toEqual(['c1', 'c2', 'b1', 'b2']);
});

test('each folded-in broken option is flagged and keeps a continuing order', () => {
  const out = buildClassOptions(valid, broken);
  const b1 = out.find((o) => o.id === 'b1')!;
  const b2 = out.find((o) => o.id === 'b2')!;
  expect(b1).toMatchObject({ id: 'b1', name: 'legacy', color: '#333', order: 2, broken: true });
  expect(b2).toMatchObject({ id: 'b2', name: 'orphan', color: '#444', order: 3, broken: true });
});

test('with no valid palette, broken options are ordered from zero', () => {
  const out = buildClassOptions([], broken);
  expect(out.map((o) => o.order)).toEqual([0, 1]);
  expect(out.every((o) => o.broken)).toBe(true);
});

test('empty inputs yield an empty option list', () => {
  expect(buildClassOptions([], [])).toEqual([]);
});
