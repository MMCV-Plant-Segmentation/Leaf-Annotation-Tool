import type { Ring } from './geoEngine';

/** Two centreline points closer than this × the brush diameter overlap → their bands touch. */
const REACH = 0.95;
/** …but only count as closing a loop when this many diameters of stroke lie between them
 *  (consecutive points always overlap; that's not a loop). */
const MIN_ARC = 2;

/** Live-preview LOOP FILL (Christian 2026-10-11 — the live fill the t158 preview lost).
 *
 * The stored outline drops every interior hole, so a brush stroke that comes back onto itself
 * stores as one solid region. The preview paints the centreline as a round stroke, which leaves
 * the hole open — so here we find where the pen's band touches earlier ink and fill the loop it
 * closes. A loop = the centreline from the earlier point to the touching one, closed by the
 * short segment between them; that whole curve lies inside the band, so its interior is inside
 * the stored (hole-filled) shape — the fill can never show area the server won't store.
 *
 * Incremental like the brush itself: each frozen point is one grid lookup; a closed loop is
 * emitted once (at the touch's onset) and never changes. Only the pen's provisional loop is
 * rebuilt per move, and only while it touches earlier ink. */
export function createLoopFinder() {
  let pts: Ring = [];
  let arc: number[] = [];
  let grid = new Map<string, number[]>();
  let cell = 1;  // grid cell = touch distance
  let minArc = 0;
  let touching = false;
  let loops: Ring[] = [];

  const key = (x: number, y: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;

  /** The LATEST frozen point (at least MIN_ARC diameters back) whose band `p` touches, -1 if
   *  none — the most recent pass the pen came back onto, so the loop is the one it just closed
   *  (small and cheap even in a back-and-forth scribble). */
  function latestTouch(p: number[], arcAt: number): number {
    const cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell);
    let best = -1;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const j of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
        if (j <= best || arcAt - arc[j] < minArc) continue;
        if (Math.hypot(pts[j][0] - p[0], pts[j][1] - p[1]) < cell) best = j;
      }
    }
    return best;
  }

  function reset(size: number): void {
    pts = []; arc = []; grid = new Map(); touching = false; loops = [];
    cell = Math.max(size, 1e-6) * REACH; minArc = MIN_ARC * size;
  }

  /** Append one FROZEN centreline point. */
  function add(p: number[]): void {
    const last = pts[pts.length - 1];
    const a = last ? arc[arc.length - 1] + Math.hypot(p[0] - last[0], p[1] - last[1]) : 0;
    const j = latestTouch(p, a);
    if (j >= 0 && !touching) loops = [...loops, pts.slice(j).concat([p])];
    touching = j >= 0;
    const k = key(p[0], p[1]);
    const i = pts.length;
    pts.push(p); arc.push(a);
    const bucket = grid.get(k);
    if (bucket) bucket.push(i); else grid.set(k, [i]);
  }

  /** The loop the provisional `tail` closes right now (pen end touching earlier ink), or null. */
  function live(tail: Ring): Ring | null {
    const end = tail[tail.length - 1];
    if (!end || !pts.length) return null;
    let a = arc[arc.length - 1], prev = pts[pts.length - 1];
    for (const q of tail) { a += Math.hypot(q[0] - prev[0], q[1] - prev[1]); prev = q; }
    const j = latestTouch(end, a);
    return j >= 0 ? pts.slice(j).concat(tail) : null;
  }

  return { reset, add, live, loops: () => loops };
}
