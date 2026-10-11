// t93 — persist the annotator brush size across reloads. localStorage, NOT the URL
// (the URL carries the viewport (t92); brush size is a personal tool preference, not a
// shareable view). Kept dependency-free so brushSizePersist.spec.ts can import it directly.
const KEY = 'leaf.annotator.brushSize';

/** The last brush size the user chose, or null if none stored / storage unavailable /
 *  the stored value is not a positive number. Rounded to a whole pixel. */
export function loadBrushSize(): number | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  } catch {
    return null; // private mode / storage disabled — non-fatal
  }
}

/** Persist the current brush size. Ignores non-positive/non-finite values (the pre-default
 *  sentinel is 0) and swallows storage errors (private mode) — persistence is best-effort. */
export function saveBrushSize(n: number): void {
  try {
    if (Number.isFinite(n) && n > 0) localStorage.setItem(KEY, String(Math.round(n)));
  } catch {
    /* storage disabled — non-fatal */
  }
}
