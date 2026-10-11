import { isPenMode } from './penMode';

/**
 * t161 — pen-mode touch gating, factored out of canvasInteraction.ts to keep it under the
 * line budget.
 *
 * While pen mode is ON:
 *  - a touch pointer only navigates (pans/pinches) with every tool — never draws, erases
 *    or selects;
 *  - while ANY pen pointer is down, every touch pointer is ignored entirely: not captured,
 *    never added to the caller's multi-touch set, never a pinch finger, never a pan;
 *  - a touch ALREADY down when the pen lands (the usual palm-first order) is dropped from the
 *    multi-touch set, so it can't pair with the pen as a pinch, and its later moves are ignored.
 * Pen mode OFF: everything here is a no-op (pen stays a generic pointer, like today).
 */
export function createPenModeGate() {
  const activePens = new Set<number>();

  /** Call at the top of onPointerDown. true ⇒ the caller must ignore this pointer entirely. */
  const onDown = (e: PointerEvent, touches: Map<number, unknown>): boolean => {
    if (!isPenMode()) return false;
    if (e.pointerType === 'touch' && activePens.size > 0) return true;
    if (e.pointerType === 'pen') { activePens.add(e.pointerId); touches.clear(); }  // drop a resting palm
    return false;
  };

  /** A move for a touch that was ignored at its pointerdown (so it's absent from `touches`). */
  const isIgnoredMove = (e: PointerEvent, touches: Map<number, unknown>): boolean =>
    isPenMode() && e.pointerType === 'touch' && activePens.size > 0 && !touches.has(e.pointerId);

  /** This event is a pen-mode touch — navigation only, regardless of the active tool. */
  const isTouchNav = (e: PointerEvent): boolean => isPenMode() && e.pointerType === 'touch';

  const release = (pointerId: number): void => { activePens.delete(pointerId); };

  return { onDown, isIgnoredMove, isTouchNav, release };
}
