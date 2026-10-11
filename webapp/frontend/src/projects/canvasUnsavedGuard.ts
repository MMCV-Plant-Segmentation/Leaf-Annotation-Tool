/**
 * beforeunload guard for the annotation canvas — extracted from CanvasScreen so that
 * file stays under the 200-line cap.
 *
 * The socket now carries persist-critical mutations (create/edit/erase/relabel/undo).
 * If the user tries to close/reload the tab while any of those is still enqueued or
 * in-flight, warn them via the standard `beforeunload` prompt. Fire-and-forget
 * viewport telemetry (canvasSocket.post) does NOT count toward hasPending() — we
 * warn only for REAL annotation data.
 *
 * `hasPending()` is polled inside the listener so we always read the LATEST state
 * (the beforeunload event fires at unload time, not at listener-attach time).
 */
import { onCleanup } from 'solid-js';

export interface UnsavedGuardOpts {
  hasPending: () => boolean;
  message: () => string;
}

export function createUnsavedGuard(o: UnsavedGuardOpts): void {
  // Register synchronously with the reactive owner (CanvasScreen is client-only —
  // no SSR to defer past). onMount would fire on the same microtask but adds a
  // scheduler dependency the unit tests would need to flush; direct-register keeps
  // the module testable with a plain createRoot + no scheduler tick.
  const onBeforeUnload = (e: BeforeUnloadEvent) => {
    if (!o.hasPending()) return;
    e.preventDefault();
    // Firefox echoes returnValue; most other browsers show a generic prompt.
    e.returnValue = o.message();
    return o.message();
  };
  window.addEventListener('beforeunload', onBeforeUnload);
  onCleanup(() => window.removeEventListener('beforeunload', onBeforeUnload));
}
