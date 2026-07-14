// BUGS #15: FE-only read-only enforcement for an admin viewing another user's
// annotations. An admin may look but must NOT add or delete annotations for that
// user — the canvas commit (paint stroke or eraser) is made a no-op when an admin
// is the viewer. The admin's API-level ability is intentionally left intact for
// possible future admin-modification features; this guards the FE gesture path only,
// consistent with `readOnly={isAdmin()} / onToggle={isAdmin() ? undefined : ...}`
// already used in CanvasScreen.tsx.
//
// Kept as a tiny module of its own so CanvasScreen.tsx stays under its line limit.

/** A persistence `commit` (see createCanvasPersistence): async, fire-and-forget. The
 * trailing `tool` arg carries the input mode ('brush' | 'polyline') so the stroke's
 * provenance is recorded server-side; brush is the default when omitted. Return is
 * `unknown` so the polyline per-click rebuild can pass a create-result-returning
 * commit through unchanged (see canvasPersistence.ts's polyline session hook). */
type CommitFn = (kind: string, points: number[][], passNo?: number, strokeWidth?: number, tool?: string) => void | Promise<unknown>;

/**
 * Wraps a canvas persistence `commit` so it does nothing when `readOnly` is true
 * (an admin viewer). Otherwise it forwards to the real commit unchanged. Used by
 * createCanvasInteraction so no draw/erase gesture produces a server write for an
 * admin, no matter which tool is selected.
 */
export function adminReadOnlyCommit(
  readOnly: boolean,
  commit: CommitFn,
  kind: string,
  points: number[][],
  passNo?: number,
  strokeWidth?: number,
  tool?: string,
): void {
  if (readOnly) return;
  void commit(kind, points, passNo, strokeWidth, tool);
}
