// Viewport-attention HEATMAP grid math — pure functions, no DOM/Solid.
//
// Design (the "stared long AND zoomed in tight lights up brightest" rule):
//  - Lay an N x M grid over the image (image-space).
//  - Walk consecutive samples from the SAME user on this image (the backend already
//    orders rows by (user_id, client_ts)). For each pair, compute Delta-t = the gap
//    between the earlier sample's clientTs and the next sample's clientTs, CAPPED at
//    an idle threshold (IDLE_MS) so an idle gap doesn't dump unbounded attention.
//  - Deposit a CONSTANT amount of attention per unit time, spread UNIFORMLY over the
//    EARLIER sample's viewport rect: add K * Delta-t / (w * h) to every grid cell whose
//    center falls inside that rect. Same total attention per sample regardless of zoom;
//    a smaller (more zoomed-in) rect concentrates it into fewer, denser cells, so dwell
//    time x zoom-closeness combine naturally.
//  - Sum over all samples and all users, then normalize the grid to [0, 1] for the
//    color-range mapping (min/max controls clamp the scale's two ends).
//
// The SVG overlay renders the normalized grid as translucent colored rectangles
// (viewportHeatmapOverlay.tsx). This module is the unit-testable core.

/** One viewport telemetry sample (wire shape from the admin endpoint). */
export type ViewportEvent = {
  userId: string;
  clientTs: string;  // ISO 8601
  x: number; y: number; w: number; h: number;  // SVG viewBox in IMAGE coords
  cssW: number; cssH: number; dpr: number;
};

/** Tunable constants for the attention model. */
export const HEATMAP = {
  /** Attention-per-unit-time constant. Uniform scale factor; cancels under
   *  normalization, so its absolute value is arbitrary — kept explicit so the model is
   *  readable and tweakable. */
  K: 1,
  /** Idle cap (ms): a gap longer than this is treated as the user walking away, not
   *  staring, so it deposits at most this much attention. 10s per the task spec. */
  IDLE_MS: 10_000,
  /** Default grid resolution (cells along the longer image axis). The other axis scales
   *  to keep cells square-ish. Higher = finer heatmap, more cells to render. */
  DEFAULT_CELLS: 80,
} as const;

export type Grid = {
  cols: number;
  rows: number;
  /** cellW / cellH in image-space pixels. */
  cellW: number;
  cellH: number;
  /** Flat Float64 row-major grid of accumulated attention (length cols*rows). */
  data: Float64Array;
};

/** Build an empty grid sized to the image, choosing cols/rows so cells are ~square.
 *  `cells` is the target count along the longer axis. */
export function makeGrid(imageW: number, imageH: number, cells = HEATMAP.DEFAULT_CELLS): Grid {
  const cols = imageW >= imageH ? cells : Math.max(1, Math.round(cells * imageW / imageH));
  const rows = imageW >= imageH ? Math.max(1, Math.round(cells * imageH / imageW)) : cells;
  return { cols, rows, cellW: imageW / cols, cellH: imageH / rows, data: new Float64Array(cols * rows) };
}

/** Parse an ISO 8601 timestamp to epoch ms. Returns NaN for unparseable input (the
 *  caller treats NaN gaps as zero attention — skip the pair). */
export function toMs(ts: string): number {
  const n = Date.parse(ts);
  return Number.isNaN(n) ? NaN : n;
}

/** Accumulate viewport attention into `grid` from `events` (already ordered by
 *  (user_id, client_ts) by the backend). Mutates grid.data in place and returns it.
 *  Pure otherwise (no DOM). */
export function accumulateAttention(grid: Grid, events: ViewportEvent[]): void {
  if (events.length < 2) return;
  const { cols, rows, cellW, cellH, data } = grid;
  let prev: ViewportEvent | null = null;
  let prevUser = '';
  for (const ev of events) {
    if (prev !== null && ev.userId === prevUser) {
      const dt = toMs(ev.clientTs) - toMs(prev.clientTs);
      if (Number.isFinite(dt) && dt > 0) {
        const cappedDt = Math.min(dt, HEATMAP.IDLE_MS);
        // Spread a constant amount of attention uniformly over the EARLIER sample's
        // viewport rect: density = K * dt / (w*h) per unit area, added to every cell
        // whose center falls inside that rect.
        const w = prev.w; const h = prev.h;
        const area = w * h;
        if (area > 0) {
          const density = (HEATMAP.K * cappedDt) / area;
          const x0 = prev.x; const y0 = prev.y;
          // Cell center (i,j) is at (x0c + (i+0.5)*cellW, y0c + (j+0.5)*cellH) in image
          // coords, where the grid origin is (0,0). Test against the rect [x0,x0+w]x[y0,y0+h].
          const iStart = Math.max(0, Math.floor(x0 / cellW));
          const iEnd = Math.min(cols - 1, Math.floor((x0 + w) / cellW));
          const jStart = Math.max(0, Math.floor(y0 / cellH));
          const jEnd = Math.min(rows - 1, Math.floor((y0 + h) / cellH));
          for (let j = jStart; j <= jEnd; j++) {
            const cy = (j + 0.5) * cellH;
            if (cy < y0 || cy >= y0 + h) continue;
            for (let i = iStart; i <= iEnd; i++) {
              const cx = (i + 0.5) * cellW;
              if (cx < x0 || cx >= x0 + w) continue;
              data[j * cols + i] += density;
            }
          }
        }
      }
    }
    prev = ev;
    prevUser = ev.userId;
  }
}

/** Min/max of the accumulated grid (raw attention, before normalization). Returns
 *  [0,0] for an all-zero grid. */
export function gridExtent(grid: Grid): [number, number] {
  let lo = Infinity; let hi = -Infinity;
  for (const v of grid.data) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 0];
  return [lo, hi];
}

/** Normalize the grid to [0,1] and return it (mutates data in place). An all-zero or
 *  constant grid becomes all-zero (nothing to color). */
export function normalizeGrid(grid: Grid): void {
  const [, hi] = gridExtent(grid);
  if (!(hi > 0)) { grid.data.fill(0); return; }
  for (let i = 0; i < grid.data.length; i++) grid.data[i] = grid.data[i] / hi;
}

/** Map a normalized value v in [0,1] to an RGBA color via a translucent viridis-ish
 *  ramp. `lo`/`hi` are the color-range endpoints (0..1) the admin can tune: values
 *  below `lo` are fully transparent (clipped out), values above `hi` saturate to the
 *  hottest color. Between, the value is rescaled over [lo,hi] then ramped.
 *  Returns [r,g,b,a] 0..255 / 0..1. */
export function heatColor(
  v: number, lo: number, hi: number, maxAlpha = 0.65,
): [number, number, number, number] {
  if (v <= 0) return [0, 0, 0, 0];
  // Rescale over the admin's [lo,hi] window.
  const span = hi - lo;
  let t = span > 0 ? (v - lo) / span : (v >= hi ? 1 : 0);
  if (!Number.isFinite(t)) t = 0;
  if (t <= 0) return [0, 0, 0, 0];
  if (t > 1) t = 1;
  // Viridis-ish stops: dark purple -> blue -> teal -> green -> yellow.
  const stops: [number, [number, number, number]][] = [
    [0.0, [68, 1, 84]],
    [0.25, [59, 82, 139]],
    [0.5, [33, 144, 141]],
    [0.75, [94, 201, 98]],
    [1.0, [253, 231, 37]],
  ];
  let c0 = stops[0][1]; let c1 = stops[stops.length - 1][1]; let f = 0;
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i][0] && t <= stops[i + 1][0]) {
      c0 = stops[i][1]; c1 = stops[i + 1][1];
      const range = stops[i + 1][0] - stops[i][0];
      f = range > 0 ? (t - stops[i][0]) / range : 0;
      break;
    }
  }
  const r = Math.round(c0[0] + (c1[0] - c0[0]) * f);
  const g = Math.round(c0[1] + (c1[1] - c0[1]) * f);
  const b = Math.round(c0[2] + (c1[2] - c0[2]) * f);
  // Alpha rises with intensity so faint attention reads as a soft wash and hot cells
  // pop, capped at maxAlpha so the underlying image stays visible.
  const a = Math.min(maxAlpha, 0.15 + 0.85 * t);
  return [r, g, b, a];
}
