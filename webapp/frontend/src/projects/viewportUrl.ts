// t92 — pure encode/decode helpers for persisting the annotator canvas viewport (pan/zoom)
// in a URL query param. Kept dependency-free so viewportUrl.spec.ts can import it directly.
import type { ViewBox } from './canvasShapes';

// Underscore-delimited (NOT comma — encodeURIComponent escapes commas, which would fail the
// "safe to drop straight into a query value" contract). Rounded to whole pixels: plenty of
// precision for restoring a view, and keeps the encoded string short.
const SEP = '_';

export function encodeViewport(vb: ViewBox): string {
  const r = (n: number) => Math.round(n);
  return [r(vb.x), r(vb.y), r(vb.w), r(vb.h)].join(SEP);
}

export function decodeViewport(str: string): ViewBox | null {
  if (!str) return null;
  const parts = str.split(SEP);
  if (parts.length !== 4) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const [x, y, w, h] = nums;
  if (!(w > 0) || !(h > 0)) return null;
  return { x, y, w, h };
}
