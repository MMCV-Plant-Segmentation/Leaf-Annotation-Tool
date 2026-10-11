/**
 * Polyline splice detection (t67) — PURE, DOM-free, unit-testable.
 *
 * When a freshly-drawn polyline run's FIRST and LAST vertices are both snapped (t50) onto
 * an ADJACENT pair of vertices in an EXISTING stroke, the run's middle vertices should be
 * spliced INTO that stroke — replacing the direct edge between the two adjacent vertices —
 * and the standalone run discarded. This module decides whether a finish qualifies and, if
 * so, produces the existing stroke's NEW point + vertex-ref lists for the splice op. The
 * finish-time wiring + the server round-trip live in CanvasScreen / canvasPersistence.
 */

/** Minimal stroke shape the detector scans (every loaded annotation's member strokes). */
export type SpliceStroke = { id: string; points: number[][]; vertexIds?: string[] };

/** The existing stroke to rewrite + its spliced geometry (endpoints keep their shared ids;
 *  the run's middle vertices carry their own ids so they persist). */
export type SpliceTarget = {
  existingStrokeId: string;
  points: number[][];
  vertexRefs: (string | null)[];
};

/**
 * Does this finish qualify as a splice? Needs ≥1 middle vertex (draft.length ≥ 3), both
 * endpoints snapped onto DISTINCT existing vertices, and a stroke (not the run itself) that
 * holds both at ADJACENT indices. Returns the rewrite for that stroke, or null (→ the run
 * finishes as its own mark). Orientation is normalised so the middles always read lo→hi.
 */
export function detectSplice(
  draft: number[][], draftRefs: (string | null)[],
  strokes: SpliceStroke[], runStrokeId: string | null,
): SpliceTarget | null {
  const n = draft.length;
  if (n < 3) return null;
  const firstRef = draftRefs[0];
  const lastRef = draftRefs[n - 1];
  if (!firstRef || !lastRef || firstRef === lastRef) return null;

  for (const s of strokes) {
    if (s.id === runStrokeId || !s.vertexIds) continue;
    const posA = s.vertexIds.indexOf(firstRef);
    const posB = s.vertexIds.indexOf(lastRef);
    if (posA < 0 || posB < 0 || Math.abs(posA - posB) !== 1) continue;

    const lo = Math.min(posA, posB);
    const hi = lo + 1;
    let middles = draft.slice(1, n - 1);
    let middleRefs = draftRefs.slice(1, n - 1);
    // firstRef sits at hi means the run was drawn hi→lo — reverse so it reads lo→hi.
    if (posA === hi) { middles = middles.slice().reverse(); middleRefs = middleRefs.slice().reverse(); }

    return {
      existingStrokeId: s.id,
      points: [...s.points.slice(0, lo + 1), ...middles, ...s.points.slice(hi)],
      vertexRefs: [...s.vertexIds.slice(0, lo + 1), ...middleRefs, ...s.vertexIds.slice(hi)],
    };
  }
  return null;
}

/** Build the polyline FINISH handler (t67): if the just-drawn run qualifies as a splice,
 *  route the splice op; otherwise finish normally. Kept here so CanvasScreen stays thin.
 *  Reads draft/refs synchronously (the keyboard finishes before clearing the draft). */
export function makeFinishOrSplice(deps: {
  draft: () => number[][];
  draftRefs: () => (string | null)[];
  annotations: () => { strokes?: SpliceStroke[] }[];
  runStrokeId: () => string | null;
  brushSize: () => number;
  splice: (existingStrokeId: string, points: number[][], refs: (string | null)[],
           removeStrokeId: string, strokeWidth: number) => void;
  finish: () => void;
}): () => void {
  return () => {
    const runSid = deps.runStrokeId();
    const strokes = deps.annotations().flatMap((a) => a.strokes ?? []);
    const target = runSid ? detectSplice(deps.draft(), deps.draftRefs(), strokes, runSid) : null;
    if (target && runSid) deps.splice(target.existingStrokeId, target.points, target.vertexRefs, runSid, deps.brushSize());
    else deps.finish();
  };
}
