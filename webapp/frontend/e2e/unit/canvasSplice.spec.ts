/**
 * Polyline splice detection (t67) — pure unit tests.
 *
 * A finished run whose first & last vertices snapped onto an ADJACENT pair of an existing
 * stroke splices its middle vertices into that stroke between the pair (endpoints keep
 * their shared ids; middles carry the run's own ids). Non-qualifying finishes → null.
 */
import { test, expect } from '@playwright/test';
import { detectSplice } from '../../src/projects/canvasSplice';

// Existing polyline A(vA,10,10) — B(vB,40,10) — C(vC,40,40). vA,vB are adjacent (idx 0,1).
const existing = {
  id: 'S', points: [[10, 10, 4], [40, 10, 4], [40, 40, 4]], vertexIds: ['vA', 'vB', 'vC'],
};

test('splices a run drawn A→m→B into the existing stroke between the adjacent pair', () => {
  // run: A (snap vA) → m(25,0) → B (snap vB)
  const draft = [[10, 10, 4], [25, 0, 4], [40, 10, 4]];
  const refs = ['vA', null, 'vB'];
  const out = detectSplice(draft, refs, [existing], 'RUN');
  expect(out).not.toBeNull();
  expect(out!.existingStrokeId).toBe('S');
  // A, m, B, C — the middle inserted between vA(0) and vB(1)
  expect(out!.points).toEqual([[10, 10, 4], [25, 0, 4], [40, 10, 4], [40, 40, 4]]);
  expect(out!.vertexRefs).toEqual(['vA', null, 'vB', 'vC']);
});

test('normalises orientation when the run is drawn B→m→A (reverses the middles)', () => {
  // run drawn from B to A: B (snap vB) → m1(30,0) → m2(20,0) → A (snap vA)
  const draft = [[40, 10, 4], [30, 0, 4], [20, 0, 4], [10, 10, 4]];
  const refs = ['vB', null, null, 'vA'];
  const out = detectSplice(draft, refs, [existing], 'RUN');
  expect(out).not.toBeNull();
  // stored order stays A..B..C, so middles read A→B: (20,0) then (30,0)
  expect(out!.points).toEqual([[10, 10, 4], [20, 0, 4], [30, 0, 4], [40, 10, 4], [40, 40, 4]]);
  expect(out!.vertexRefs).toEqual(['vA', null, null, 'vB', 'vC']);
});

test('preserves a middle vertex that itself snapped (keeps its id as a ref)', () => {
  const draft = [[10, 10, 4], [25, 0, 4], [40, 10, 4]];
  const refs = ['vA', 'vX', 'vB'];
  const out = detectSplice(draft, refs, [existing], 'RUN');
  expect(out!.vertexRefs).toEqual(['vA', 'vX', 'vB', 'vC']);
});

test('null when the endpoints are NOT an adjacent pair (vA & vC, indices 0 and 2)', () => {
  const draft = [[10, 10, 4], [25, 25, 4], [40, 40, 4]];
  const refs = ['vA', null, 'vC'];
  expect(detectSplice(draft, refs, [existing], 'RUN')).toBeNull();
});

test('null for <3 points, an unsnapped endpoint, or the same vertex at both ends', () => {
  expect(detectSplice([[10, 10], [40, 10]], ['vA', 'vB'], [existing], 'RUN')).toBeNull();
  expect(detectSplice([[10, 10], [25, 0], [40, 10]], ['vA', null, null], [existing], 'RUN')).toBeNull();
  expect(detectSplice([[10, 10], [25, 0], [10, 10]], ['vA', null, 'vA'], [existing], 'RUN')).toBeNull();
});

test('ignores the run\'s OWN stroke when scanning for a target', () => {
  const draft = [[10, 10, 4], [25, 0, 4], [40, 10, 4]];
  const refs = ['vA', null, 'vB'];
  // the only stroke that holds vA,vB adjacent IS the run → no external target → null
  const runAsStroke = { id: 'RUN', points: draft, vertexIds: ['vA', 'vX', 'vB'] };
  expect(detectSplice(draft, refs, [runAsStroke], 'RUN')).toBeNull();
});
