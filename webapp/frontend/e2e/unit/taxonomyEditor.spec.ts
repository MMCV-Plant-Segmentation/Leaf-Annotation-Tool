/**
 * Unit tests for the taxonomy-editor save-model helpers (t74/t76 rework):
 *   flushPending — fold a valid in-progress compound edit into the list (the single-Save
 *                  flush), a no-op when the edit is invalid/empty/null.
 *   taxonomyKey  — order-normalized dirty-check identity (a pending rename must register as
 *                  a change; a pure reorder of equal content must not spuriously differ).
 */
import { test, expect } from '@playwright/test';
import { flushPending, taxonomyKey } from '../../src/projects/taxonomyEditor';
import { compoundLabel, deriveLabel } from '../../src/projects/taxonomy';
import type { Compound, Group } from '../../src/projects/taxonomy';

const groups: Group[] = [
  { id: 'g1', name: 'shape', order: 0, required: true,
    members: [{ id: 'm1', name: 'round', order: 0 }, { id: 'm2', name: 'jagged', order: 1 }] },
];
const thing: Compound = { id: 'c1', name: 'thing', color: '#111', selections: { g1: 'm1' } };

test('flushPending updates an existing compound in place', () => {
  const pending: Compound = { ...thing, name: 'renamed' };
  const out = flushPending([thing], pending, groups);
  expect(out).toHaveLength(1);
  expect(out[0].name).toBe('renamed');
  expect(out[0].id).toBe('c1');
});

test('flushPending appends a valid brand-new compound', () => {
  const fresh: Compound = { id: 'c2', name: 'new', color: '#222', selections: { g1: 'm2' } };
  const out = flushPending([thing], fresh, groups);
  expect(out.map((c) => c.id)).toEqual(['c1', 'c2']);
});

test('flushPending is a no-op for null / invalid pending', () => {
  expect(flushPending([thing], null, groups)).toEqual([thing]);
  // Missing the required group selection → invalid → not folded in.
  const invalid: Compound = { id: 'c9', name: 'x', color: '#333', selections: {} };
  expect(flushPending([thing], invalid, groups)).toEqual([thing]);
});

test('t89: flushPending folds a VALID compound whose name was cleared (empty derives)', () => {
  // Clearing the name of an existing valid compound is now a real edit, not a no-op —
  // the compound keeps its selection and will derive its label from the member.
  const out = flushPending([thing], { ...thing, name: '   ' }, groups);
  expect(out).toEqual([{ ...thing, name: '' }]);
});

test('t89: compoundLabel/deriveLabel — custom name verbatim, empty derives from members', () => {
  expect(compoundLabel(thing, groups)).toBe('thing');
  expect(compoundLabel({ ...thing, name: '' }, groups)).toBe('round');
  const g2: Group[] = [...groups, { id: 'g2', name: 'size', order: 1, required: false,
    members: [{ id: 'm3', name: 'big', order: 0 }] }];
  const empty: Compound = { id: 'c1', name: '', color: '#111', selections: { g1: 'm1', g2: 'm3' } };
  expect(deriveLabel(empty, g2)).toBe('round / big');
});

test('flushPending trims the saved name', () => {
  const out = flushPending([thing], { ...thing, name: '  spacey  ' }, groups);
  expect(out[0].name).toBe('spacey');
});

test('taxonomyKey is stable to member reorder normalization but sees a rename', () => {
  const base = taxonomyKey(groups, [thing]);
  // Same content, different order stamps → normalized equal.
  const reordered: Group[] = [{ ...groups[0], order: 9,
    members: [{ id: 'm1', name: 'round', order: 5 }, { id: 'm2', name: 'jagged', order: 8 }] }];
  expect(taxonomyKey(reordered, [thing])).toBe(base);
  // A rename is a real change.
  expect(taxonomyKey(groups, [{ ...thing, name: 'renamed' }])).not.toBe(base);
});

test('taxonomyKey ignores selections key order', () => {
  const g2: Group[] = [...groups, { id: 'g2', name: 'colour', order: 1, required: false,
    members: [{ id: 'm3', name: 'red', order: 0 }] }];
  const a: Compound = { id: 'c1', name: 'thing', color: '#111', selections: { g1: 'm1', g2: 'm3' } };
  const b: Compound = { id: 'c1', name: 'thing', color: '#111', selections: { g2: 'm3', g1: 'm1' } };
  expect(taxonomyKey(g2, [a])).toBe(taxonomyKey(g2, [b]));
});
