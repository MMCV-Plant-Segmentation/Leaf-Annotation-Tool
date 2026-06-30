import { type Component, Show } from 'solid-js';
import { getStroke } from 'perfect-freehand';
import type { CanvasAnnotation, Rect } from './api';

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

// Build an SVG path string for a brush stroke (or live draft when last=false).
// size is in image-space pixels (constant world size regardless of zoom).
export function buildStrokePath(points: number[][], size: number, last = true): string {
  const outline = getStroke(points, {
    size, thinning: 0, smoothing: 0.5, last, simulatePressure: false,
  });
  return outlineToPath(outline as number[][]);
}

// One committed annotation rendered as the appropriate SVG primitive.
export const AnnotationShape: Component<{
  ann: CanvasAnnotation; selected: boolean; onSelect: () => void; onErase?: () => void;
}> = (props) => {
  const stroke = () => (props.selected ? '#dc2626' : '#2563eb');
  const onDown = (e: PointerEvent) => { e.stopPropagation(); if (props.onErase) props.onErase(); else props.onSelect(); };
  return (
    <Show when={props.ann.kind === 'stroke'} fallback={
      <Show when={props.ann.kind === 'point'} fallback={
        <Show when={props.ann.kind === 'line'} fallback={
          <polygon points={props.ann.points.map((p) => p.join(',')).join(' ')}
            fill="rgba(37,99,235,0.18)" stroke={stroke()} stroke-width="2"
            vector-effect="non-scaling-stroke" onPointerDown={onDown} />
        }>
          <polyline points={props.ann.points.map((p) => p.join(',')).join(' ')}
            fill="none" stroke={stroke()} stroke-width="2"
            vector-effect="non-scaling-stroke" onPointerDown={onDown} />
        </Show>
      }>
        <circle cx={props.ann.points[0][0]} cy={props.ann.points[0][1]} r="5"
          fill={stroke()} vector-effect="non-scaling-stroke" onPointerDown={onDown} />
      </Show>
    }>
      <path d={buildStrokePath(props.ann.points, props.ann.strokeWidth ?? 10)}
        fill={stroke()} fill-opacity="0.75" onPointerDown={onDown} />
    </Show>
  );
};

// Clamp a viewport to the image bounds (used when persisting an annotation's viewport).
export function clampRect(v: ViewBox, w: number, h: number): Rect {
  const x = Math.max(0, Math.round(v.x));
  const y = Math.max(0, Math.round(v.y));
  return { x, y, w: Math.min(w - x, Math.round(v.w)), h: Math.min(h - y, Math.round(v.h)) };
}
