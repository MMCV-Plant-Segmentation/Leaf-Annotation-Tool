import { brushStreamEndSync, brushStreamPushSync, type Ring } from './geoEngine';

/** Frozen centreline points per closed chunk path. A closed chunk never changes again, so its SVG
 * path is never re-rendered; only the open chunk + tail (bounded) are redrawn per pointer move. */
export const BRUSH_CHUNK_POINTS = 64;

export type Box = { x0: number; y0: number; x1: number; y1: number };

/** The live brush's centreline, split for rendering: `chunks` are closed and immutable (each
 * starts at the previous chunk's last point, so the stroke is continuous); `live` is the open
 * chunk followed by the provisional tail; `box` bounds everything. */
export type BrushLine = { chunks: Ring[]; live: Ring; box: Box | null };

const EMPTY: BrushLine = { chunks: [], live: [], box: null };

function grow(box: Box | null, p: number[]): Box {
  if (!box) return { x0: p[0], y0: p[1], x1: p[0], y1: p[1] };
  return { x0: Math.min(box.x0, p[0]), y0: Math.min(box.y0, p[1]),
    x1: Math.max(box.x1, p[0]), y1: Math.max(box.y1, p[1]) };
}

/** t158 — the live brush centreline, built incrementally from a growing draft.
 *
 * The engine's brush is a stream: each new point can only change a short tail behind the pen
 * (see geo-engine/src/brush.rs). So per pointer move we hand the engine just the new draft
 * points and append what it froze — O(new points) per move, not O(stroke). A draft that is not
 * an extension of the last one (new stroke, cleared, size changed) restarts the stream. */
export function createBrushStream() {
  let id: number | undefined;
  let fed = 0;
  let first: number[] | undefined;
  let size = 0;
  let chunks: Ring[] = [];
  let open: Ring = [];
  let frozenBox: Box | null = null;

  function end(): void {
    if (id !== undefined) brushStreamEndSync(id);
    id = undefined; fed = 0; first = undefined; chunks = []; open = []; frozenBox = null;
  }

  function update(draft: Ring, sz: number): BrushLine {
    if (!draft.length || draft[0] !== first || draft.length < fed || sz !== size) end();
    if (!draft.length) return EMPTY;
    const r = brushStreamPushSync(id, sz, draft.slice(fed));
    if (!r) return EMPTY;  // engine not loaded yet — retry from scratch next move
    id = r.id; fed = draft.length; first = draft[0]; size = sz;
    for (const p of r.frozen) {
      open.push(p);
      frozenBox = grow(frozenBox, p);
      if (open.length === BRUSH_CHUNK_POINTS) { chunks = [...chunks, open]; open = [p]; }
    }
    let box = frozenBox;
    for (const p of r.tail) box = grow(box, p);
    return { chunks, live: open.concat(r.tail), box };
  }

  return { update, end };
}
