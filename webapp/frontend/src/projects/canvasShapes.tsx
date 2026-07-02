import { type Component, For, Show } from 'solid-js';
import { getStroke } from 'perfect-freehand';
import type { CanvasAnnotation, CanvasTile, Rect, TileStateUpdate } from './api';

export type Tool = 'pan' | 'polygon' | 'point' | 'line' | 'brush' | 'eraser';
export type ViewBox = { x: number; y: number; w: number; h: number };

export const TILE_COLORS: Record<string, string> = {
  assigned: '#9ca3af', completed: '#16a34a', dirty: '#f59e0b',
};

// Convert a flat outline polygon (from getStroke) to a smooth SVG path via
// quadratic bezier chords — the Steve Ruiz idiom for perfect-freehand output.
function outlineToPath(pts: number[][]): string {
  if (!pts.length) return '';
  const d: (string | number)[] = ['M', pts[0][0], pts[0][1], 'Q'];
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    d.push(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }
  d.push('Z');
  return d.join(' ');
}

// Compute the perfect-freehand outline polygon for a brush stroke.
// Returns the raw getStroke result (number[][] polygon in image coords).
// The outline is the actual painted shape; re-used by buildStrokePath and the API commit.
export function strokeOutline(points: number[][], size: number, last = true): number[][] {
  return getStroke(points, {
    size, thinning: 0, smoothing: 0.5, last, simulatePressure: false,
  }) as number[][];
}

// Build an SVG path string for a brush stroke (or live draft when last=false).
// size is in image-space pixels (constant world size regardless of zoom).
export function buildStrokePath(points: number[][], size: number, last = true): string {
  return outlineToPath(strokeOutline(points, size, last));
}

/** Build an SVG "M…L…Z" path from polygon rings (exterior first, then holes). */
export function ringsToPath(rings: number[][][]): string {
  return rings.map((ring) => {
    if (!ring.length) return '';
    return ['M', ring[0][0], ring[0][1],
      ...ring.slice(1).flatMap(([x, y]) => ['L', x, y]), 'Z'].join(' ');
  }).join(' ');
}

/** Tile grid with state colours, click-to-toggle badge, and completed ✓.
 * `onToggle` omitted (BUGS #15 admin read-only view) → the badge still shows state
 * but is not interactive. */
export const CanvasTiles: Component<{
  tiles: CanvasTile[]; checkClass: string; onToggle?: (tile: CanvasTile) => void;
}> = (props) => (
  <For each={props.tiles}>
    {(tile) => (
      <g>
        <rect x={tile.x} y={tile.y} width={tile.w} height={tile.h}
          fill="none" stroke={TILE_COLORS[tile.state ?? 'assigned']}
          stroke-width="2" vector-effect="non-scaling-stroke"
          stroke-dasharray={tile.state === 'completed' ? undefined : '6 4'} />
        <circle data-testid="tile-complete" class={props.checkClass}
          cx={tile.x + tile.w} cy={tile.y} r="8"
          fill={tile.state === 'completed' ? '#16a34a' : '#fff'}
          stroke="#16a34a" stroke-width="1.5" vector-effect="non-scaling-stroke"
          onPointerDown={props.onToggle ? (e) => { e.stopPropagation(); props.onToggle!(tile); } : undefined} />
        <Show when={tile.state === 'completed'}>
          <text x={tile.x + tile.w} y={tile.y} text-anchor="middle" dominant-baseline="middle"
            font-size="10" fill="white" pointer-events="none">✓</text>
        </Show>
      </g>
    )}
  </For>
);

// One persisted annotation rendered as the appropriate SVG primitive. Read-only —
// deletion is the eraser BRUSH (drag over a mask), not a click affordance (see BUGS #17).
// kind='stroke' is a fused MASK: it renders straight from the server-stored `rings`
// (drop_holes(union(...)) of every bridged stroke) — no client-side re-derivation, no
// separate lesion-union overlay. point/line/polygon never fuse, so they still render
// from their own `points`, unchanged from before.
export const AnnotationShape: Component<{ ann: CanvasAnnotation }> = (props) => {
  const stroke = '#2563eb';
  return (
    <Show when={props.ann.kind === 'stroke'} fallback={
      <Show when={props.ann.kind === 'point'} fallback={
        <Show when={props.ann.kind === 'line'} fallback={
          <polygon points={props.ann.points.map((p) => p.join(',')).join(' ')}
            fill="rgba(37,99,235,0.18)" stroke={stroke} stroke-width="2"
            vector-effect="non-scaling-stroke" />
        }>
          <polyline points={props.ann.points.map((p) => p.join(',')).join(' ')}
            fill="none" stroke={stroke} stroke-width="2"
            vector-effect="non-scaling-stroke" />
        </Show>
      }>
        <circle cx={props.ann.points[0][0]} cy={props.ann.points[0][1]} r="5"
          fill={stroke} vector-effect="non-scaling-stroke" />
      </Show>
    }>
      <Show when={props.ann.rings.length > 0}>
        <path d={ringsToPath(props.ann.rings)} fill-rule="evenodd"
          fill={stroke} fill-opacity="0.55" stroke={stroke} stroke-width="1.5"
          vector-effect="non-scaling-stroke" />
      </Show>
    </Show>
  );
};

// Accessibility-tuned colours for the *live* brush/eraser draft + hover preview —
// deliberately louder than the committed-stroke rendering above (AnnotationShape),
// since a low-vision user needs to see her own in-progress stroke while drawing.
// A white halo is drawn under a dark-toned outline so the shape reads against both
// light and dark leaf backgrounds. Kept as one object so Christian can retune by eye.
export const LIVE_DRAFT = {
  haloColor: '#ffffff',
  haloWidth: 4,
  brushFill: 'rgba(37,99,235,0.6)',
  brushStroke: '#1e3a8a',
  eraserFill: 'rgba(220,38,38,0.6)',
  eraserStroke: '#7f1d1d',
  strokeWidth: 2,
  previewHaloWidth: 4.5,
  previewStrokeWidth: 2.5,
};

/** Live in-progress brush/eraser stroke + hover-radius preview circle. Rendered on
 * top of everything else while drawing; not shown for committed strokes. */
export const LiveDraftOverlay: Component<{
  tool: Tool; draft: number[][]; brushSize: number; hover: [number, number] | null;
}> = (props) => (
  <>
    <Show when={props.draft.length > 0 && (props.tool === 'brush' || props.tool === 'eraser')}>
      <path d={buildStrokePath(props.draft, props.brushSize, false)} fill="none"
        stroke={LIVE_DRAFT.haloColor} stroke-width={LIVE_DRAFT.haloWidth}
        vector-effect="non-scaling-stroke" pointer-events="none" />
      <path d={buildStrokePath(props.draft, props.brushSize, false)}
        fill={props.tool === 'eraser' ? LIVE_DRAFT.eraserFill : LIVE_DRAFT.brushFill}
        stroke={props.tool === 'eraser' ? LIVE_DRAFT.eraserStroke : LIVE_DRAFT.brushStroke}
        stroke-width={LIVE_DRAFT.strokeWidth}
        vector-effect="non-scaling-stroke" pointer-events="none" />
    </Show>
    <Show when={(props.tool === 'brush' || props.tool === 'eraser') && props.hover}>
      {(c) => (
        <>
          <circle cx={c()[0]} cy={c()[1]} r={props.brushSize / 2} fill="none"
            stroke={LIVE_DRAFT.haloColor} stroke-width={LIVE_DRAFT.previewHaloWidth}
            vector-effect="non-scaling-stroke" pointer-events="none" />
          <circle cx={c()[0]} cy={c()[1]} r={props.brushSize / 2} fill="none"
            stroke={props.tool === 'eraser' ? LIVE_DRAFT.eraserStroke : LIVE_DRAFT.brushStroke}
            stroke-width={LIVE_DRAFT.previewStrokeWidth}
            vector-effect="non-scaling-stroke" pointer-events="none" />
        </>
      )}
    </Show>
  </>
);

// Clamp a viewport to the image bounds (used when persisting an annotation's viewport).
export function clampRect(v: ViewBox, w: number, h: number): Rect {
  const x = Math.max(0, Math.round(v.x));
  const y = Math.max(0, Math.round(v.y));
  return { x, y, w: Math.min(w - x, Math.round(v.w)), h: Math.min(h - y, Math.round(v.h)) };
}

// BUGS #16: patch the matching tiles' state from a mutation response — shared by
// CanvasScreen's draw-commit path and canvasHistory's undo/redo/erase (same server shape).
export function mergeTileStates(tiles: CanvasTile[], updates: TileStateUpdate[]): CanvasTile[] {
  if (!updates.length) return tiles;
  return tiles.map((t) => {
    const u = updates.find((s) => s.tileId === t.tileId);
    return u ? { ...t, state: u.state } : t;
  });
}
