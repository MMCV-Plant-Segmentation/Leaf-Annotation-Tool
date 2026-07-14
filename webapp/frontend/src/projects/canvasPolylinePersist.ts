/**
 * Polyline per-click persistence session — a11y #40 rebuild (Christian, 2026-07-13).
 *
 * Each polyline click persists + fuses immediately. The FIRST click of a session runs the
 * create-annotation path (a real fused stroke mask, 1-vertex dot) and records the created
 * stroke id; each subsequent click runs `editStroke` on THAT SAME stroke id with the growing
 * point list, so the whole line stays ONE annotation — one `draw`/`merge` + N-1 `edit` history
 * entries. That single-stroke shape is what lets Ctrl+Z peel one vertex at a time and undo the
 * whole line cleanly back to zero.
 *
 * Once the stroke id is set we TRUST it and extend — we do NOT re-derive "is this stroke still
 * live?" from the canvas image on each click. The freshly-created annotation isn't yet carrying
 * its member-stroke list in the pushed view, so that check false-negatives and every click would
 * spuriously create+fuse a NEW annotation; the fused pieces then un-fuse into multiple masks on
 * undo (the bug this rebuild's first cut had — undo of a 4-click line left 4 masks instead of 0).
 * The session id is cleared EXPLICITLY instead:
 *   - `reset()` on tool-switch away from polyline (CanvasScreen), and
 *   - the `.catch()` below on any create/extend rejection — an editStroke against a stroke that
 *     was undone away 404s → reset → the next click starts a fresh session.
 *
 * Sequential ordering: clicks queue on a promise chain so click #2's edit never fires before
 * click #1's create resolves the stroke id it extends.
 *
 * Kept as its own module so canvasPersistence.ts stays under the 200-line file cap.
 */
import { createSignal } from 'solid-js';

/** Callbacks the polyline session needs from the surrounding persistence context —
 * one-liner shims over `commit` and `editStroke` in canvasPersistence.ts. */
export interface PolylineSessionCtx {
  /** Fire the create-annotation path (as brush's commit does) and return the created stroke
   * id — so the session can extend it on subsequent clicks. Null if the create was rejected. */
  create: (points: number[][], strokeWidth: number) => Promise<string | null>;
  /** Fire the editStroke PATCH to grow the current polyline stroke's point list. */
  extend: (strokeId: string, points: number[][], strokeWidth: number) => Promise<void>;
}

export function createPolylineSession(ctx: PolylineSessionCtx) {
  const [strokeId, setStrokeId] = createSignal<string | null>(null);
  // Serialize per-click work so click #2's editStroke never runs before click #1's
  // create resolves the stroke id we need to extend.
  let pending: Promise<void> = Promise.resolve();

  /** One per-click step: create on the first call (no stroke id yet), editStroke on every
   * subsequent call. See the module docstring for why we trust the id rather than re-checking
   * the (lagging) canvas image. */
  const step = (points: number[][], strokeWidth: number): void => {
    pending = pending.then(async () => {
      const sid = strokeId();
      if (sid) {
        await ctx.extend(sid, points, strokeWidth);
      } else {
        const fresh = await ctx.create(points, strokeWidth);
        setStrokeId(fresh);
      }
    }).catch(() => {
      // Never let a rejection break the chain — the underlying create/extend already surfaced
      // its own error (alert). Reset the session so the next click starts fresh instead of
      // trying to extend a probably-nonexistent stroke.
      setStrokeId(null);
    });
  };

  /** End the session — the next click will create a fresh annotation. Called on tool-switch
   * away from polyline (CanvasScreen). Idempotent; safe to call repeatedly. */
  const reset = (): void => { setStrokeId(null); };

  return { step, reset, strokeId };
}
