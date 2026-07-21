/**
 * canvasVertexEdit — the pure geometry behind the polyline/brush vertex-editing UX (a11y #40 v1b).
 *
 * When a stroke mask is SELECTED (Select tool), the FE draws a draggable handle at each of that
 * mask's member strokes' stored input points (polyline = clicked vertices; brush = the original
 * mouse points fed to perfect-freehand — editable too, even if rough). Grabbing a handle and
 * dragging moves that one vertex; on drop the FE PATCHes /strokes/<id> with the moved points.
 *
 * These are the pure helpers that keep the interaction out of CanvasScreen (≤200-line rule) and
 * unit-testable:
 *   - handleRadiusImg(screenPx, scale): a handle must be a CONSTANT SCREEN size so it stays
 *     grabbable at any zoom (the brush radius can be a single pixel — a fixed image-space size
 *     would vanish). `scale` = image-space units per screen pixel, so the image-space radius is
 *     screenPx * scale (bigger when zoomed OUT, smaller when zoomed IN).
 *   - hitHandle(strokes, px, py, radiusImg): which stroke vertex an image-space grab lands on
 *     (nearest within the radius; null if none), topmost stroke first.
 *   - moveVertex(points, index, nx, ny): the moved point list (only `index` changes).
 *
 * RED until webapp/frontend/src/projects/canvasVertexEdit.ts exists.
 */
import { test, expect } from '@playwright/test';

const MOD = '../../src/projects/canvasVertexEdit';

test.describe('canvasVertexEdit', () => {
  test('handleRadiusImg keeps a constant SCREEN size across zoom', async () => {
    const { handleRadiusImg } = await import(MOD);
    // zoomed out (2 image px per screen px) → handle is bigger in image space
    expect(handleRadiusImg(6, 2)).toBeCloseTo(12);
    // zoomed in (0.5 image px per screen px) → smaller in image space
    expect(handleRadiusImg(6, 0.5)).toBeCloseTo(3);
    // never collapses to zero even at extreme zoom-in
    expect(handleRadiusImg(6, 0)).toBeGreaterThan(0);
  });

  test('hitHandle grabs the nearest vertex within the radius, else null', async () => {
    const { hitHandle } = await import(MOD);
    const strokes = [
      { id: 's1', tool: 'polyline', points: [[10, 10], [40, 10]], strokeWidth: 4 },
      { id: 's2', tool: 'brush', points: [[80, 80], [90, 95]], strokeWidth: 4 },
    ];
    // a grab 2px from s1's second vertex within a 5px radius → that vertex
    expect(hitHandle(strokes, 41, 11, 5)).toEqual({ strokeId: 's1', index: 1 });
    // a grab near s2's first vertex
    expect(hitHandle(strokes, 81, 79, 5)).toEqual({ strokeId: 's2', index: 0 });
    // nothing within radius → null
    expect(hitHandle(strokes, 200, 200, 5)).toBeNull();
  });

  test('hitHandle returns the TOPMOST stroke when two vertices overlap', async () => {
    const { hitHandle } = await import(MOD);
    const strokes = [
      { id: 'under', tool: 'polyline', points: [[50, 50]], strokeWidth: 4 },
      { id: 'over', tool: 'polyline', points: [[50, 50]], strokeWidth: 4 },
    ];
    // later stroke paints on top → wins the grab
    expect(hitHandle(strokes, 50, 50, 5)).toEqual({ strokeId: 'over', index: 0 });
  });

  test('moveVertex replaces only the dragged vertex', async () => {
    const { moveVertex } = await import(MOD);
    const pts = [[10, 10], [40, 10], [40, 40]];
    expect(moveVertex(pts, 1, 55, 25)).toEqual([[10, 10], [55, 25], [40, 40]]);
    // does not mutate the input
    expect(pts[1]).toEqual([40, 10]);
  });

  test('t66: collapseOnAdjacent merges a vertex dropped onto an adjacent one', async () => {
    const { collapseOnAdjacent } = await import(MOD);
    const pts = [[10, 10, 4], [40, 10, 4], [40, 40, 4]];
    // drop the MIDDLE vertex 1 onto its NEXT neighbour (vertex 2 @ 40,40, within 5px) → the
    // DRAGGED vertex is removed, the neighbour stays; survivors keep their sizes
    expect(collapseOnAdjacent(pts, 1, 41, 41, 5)).toEqual([[10, 10, 4], [40, 40, 4]]);
    // drop the ENDPOINT vertex 0 onto its neighbour (vertex 1 @ 40,10) → vertex 0 removed
    expect(collapseOnAdjacent(pts, 0, 41, 9, 5)).toEqual([[40, 10, 4], [40, 40, 4]]);
    // does not mutate the input
    expect(pts.length).toBe(3);
  });

  test('t66: collapseOnAdjacent is null for an ordinary move / non-adjacent / tiny stroke', async () => {
    const { collapseOnAdjacent } = await import(MOD);
    const pts = [[10, 10], [40, 10], [40, 40], [10, 40]];
    // dropped in open space → ordinary move, no merge
    expect(collapseOnAdjacent(pts, 1, 25, 25, 5)).toBeNull();
    // dropped onto a NON-adjacent vertex (index 1 onto index 3 @ (10,40)) → not a merge
    expect(collapseOnAdjacent(pts, 1, 10, 40, 5)).toBeNull();
    // a 1-point stroke has nothing to merge into
    expect(collapseOnAdjacent([[10, 10]], 0, 10, 10, 5)).toBeNull();
  });

  test('t95: decideDrop makes a SHARED vertex MOVE even when it lands on an adjacent one', async () => {
    const { decideDrop } = await import(MOD);
    // A closed loop: one stroke whose first & last vertex are the SAME shared id (vClose).
    const loop = [{ id: 'A', strokes: [{ id: 's', points: [[10, 10], [40, 10], [40, 40], [10, 10]],
      vertexIds: ['vClose', 'v1', 'v2', 'vClose'] }] }];
    // Drag the closing vertex (index 3) onto the ADJACENT vertex 2 (@40,40). Collapse WOULD
    // fire for an unshared vertex — but vClose is shared, so it must MOVE, never delete.
    expect(decideDrop(loop as never, 's', 3, loop[0].strokes[0].points, 41, 41, 5))
      .toEqual({ kind: 'move', vertexId: 'vClose' });

    // An UNSHARED vertex dropped onto its neighbour still collapses (t66 preserved).
    const open = [{ id: 'B', strokes: [{ id: 's', points: [[10, 10], [40, 10], [40, 40]],
      vertexIds: ['a', 'b', 'c'] }] }];
    expect(decideDrop(open as never, 's', 1, open[0].strokes[0].points, 41, 41, 5))
      .toEqual({ kind: 'collapse', points: [[10, 10], [40, 40]] });

    // An unshared vertex dropped in open space is an ordinary edit.
    expect(decideDrop(open as never, 's', 1, open[0].strokes[0].points, 25, 25, 5))
      .toEqual({ kind: 'edit', points: [[10, 10], [25, 25], [40, 40]] });
  });
});
