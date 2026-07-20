/**
 * Polyline per-click persistence session — a11y #40 rebuild (Christian, 2026-07-13),
 * Phase 1 (feat/annotation-ws) polish: the ordering chain that USED to live here (the
 * `pending: Promise<void>` we serialised clicks on) is GONE. Ordering is now the socket
 * FIFO in canvasSocket.ts; this module is just a strokeId "am I on my first click?"
 * bookkeeper wrapped inside a socket.enqueue slot per click.
 *
 * Each polyline click still persists + fuses immediately: the FIRST click of a session
 * runs the create-annotation path (a real fused stroke mask, 1-vertex dot) and records the
 * created stroke id; each subsequent click runs `editStroke` on THAT SAME stroke id with
 * the growing point list, so the whole line stays ONE annotation. That single-stroke
 * shape is what lets Ctrl+Z peel one vertex at a time and undo the whole line cleanly
 * back to zero.
 *
 * The strokeId decision (create vs. extend) happens INSIDE the socket.enqueue task, not
 * at click time. Because tasks run one-at-a-time on the socket queue, click N's task
 * always reads a strokeId() that click N-1's ack has already set — so no second `create`
 * can slip through and mint a spurious second annotation. That's what "click N's ack
 * precedes click N+1's send on the same ordered channel" means concretely.
 *
 * Once the stroke id is set we TRUST it and extend — we do NOT re-derive "is this stroke
 * still live?" from the canvas image on each click; the pushed view lags the create-ack
 * for a moment and false-negatives would spuriously mint fresh annotations that then
 * un-fuse on undo. The session id is cleared EXPLICITLY:
 *   - `reset()` on tool-switch away from polyline (CanvasScreen), and
 *   - if a create/extend errors — the next click starts a fresh session.
 *
 * Kept as its own module so canvasPersistence.ts stays under the 200-line file cap.
 */
import { createSignal } from 'solid-js';
import type { CanvasSocket, SocketAck } from './canvasSocket';
import type { CreateAnnotationResult } from './canvasApi';
import type { EditStrokeResult } from './canvasStrokeEditApi';

/** Callbacks the polyline session needs from the surrounding persistence context —
 * pure body-building + view/history application. Kept as callbacks (not free imports)
 * so this module never needs to know about `updateImg`/history internals. */
export interface PolylineSessionCtx {
  socket: CanvasSocket;
  /** Build the create-op payload for the FIRST click of the session (server body).
   * `refs` (t50 phase 2b, parallel to `points`) carries each vertex's snap ref. */
  buildCreatePayload: (points: number[][], strokeWidth: number, refs: (string | null)[]) => unknown;
  /** Build the edit-op payload for a subsequent click of the SAME stroke. */
  buildEditPayload:   (strokeId: string, points: number[][], strokeWidth: number, refs: (string | null)[]) => unknown;
  /** Build the `final: true` finish-op payload (t59) — no new points, just the marker. */
  buildFinishPayload: (strokeId: string) => unknown;
  /** Splice the create-op ack into the view + push the appropriate history entry. */
  applyCreate: (result: CreateAnnotationResult, body: unknown) => void;
  /** Splice the edit-op ack into the view + push the appropriate history entry. */
  applyEdit:   (result: EditStrokeResult, strokeId: string, body: unknown) => void;
  /** t59: a finish discarded the stroke (no-tile, brush-parity) — remove it from the
   * view and surface the same notice a no-tile brush stroke's create-time reject shows. */
  applyDiscard: (result: EditStrokeResult, strokeId: string) => void;
}

export function createPolylineSession(ctx: PolylineSessionCtx) {
  const [strokeId, setStrokeId] = createSignal<string | null>(null);

  /** One per-click step. The decision (create vs. extend) is DEFERRED to inside the
   * socket-queue slot so it reads a strokeId() that the previous click's ack has
   * already settled. See the module docstring for why we no longer keep a local chain. */
  const step = (points: number[][], strokeWidth: number, refs: (string | null)[] = []): void => {
    void ctx.socket.enqueue(async (send) => {
      const sid = strokeId();
      if (sid) {
        const body = ctx.buildEditPayload(sid, points, strokeWidth, refs);
        const r: SocketAck<EditStrokeResult> = await send<EditStrokeResult>('edit', body);
        if (!r.ok) {
          // The extended stroke may have been undone away (404) — reset so the next
          // click starts a fresh session instead of extending a probably-nonexistent one.
          setStrokeId(null);
          alert(r.message);
          return;
        }
        ctx.applyEdit(r.result, sid, body);
      } else {
        const body = ctx.buildCreatePayload(points, strokeWidth, refs);
        const r: SocketAck<CreateAnnotationResult> = await send<CreateAnnotationResult>('create', body);
        if (!r.ok) {
          setStrokeId(null);
          alert(r.message);
          return;
        }
        setStrokeId(r.result.createdStrokeId);
        ctx.applyCreate(r.result, body);
      }
    });
  };

  /** End the session — the next click will create a fresh annotation. Called on tool-
   * switch away from polyline (CanvasScreen). Idempotent; safe to call repeatedly. */
  const reset = (): void => { setStrokeId(null); };

  /** t59: FINISH the in-progress polyline (two-stage ESC, stage 1) — runs the deferred
   * whole-stroke tile check server-side and either keeps the mask as-is or discards it
   * exactly like a no-tile brush stroke. Ends the session either way (a subsequent click
   * on the same tool starts a fresh line), so the caller can stay on the polyline tool. */
  const finish = (): void => {
    const sid = strokeId();
    if (!sid) return;
    void ctx.socket.enqueue(async (send) => {
      const body = ctx.buildFinishPayload(sid);
      const r: SocketAck<EditStrokeResult> = await send<EditStrokeResult>('edit', body);
      setStrokeId(null);
      if (!r.ok) { alert(r.message); return; }
      if (r.result.discarded) ctx.applyDiscard(r.result, sid);
      // Kept: nothing to splice — the mask is already reflected in the view from the
      // per-click create/edit acks that built it.
    });
  };

  return { step, reset, finish, strokeId };
}
