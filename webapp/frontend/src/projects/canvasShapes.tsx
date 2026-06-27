import { type Component, Show } from 'solid-js';
import type { CanvasAnnotation, Rect } from './api';

export type Tool = 'pan' | 'polygon' | 'point' | 'line' | 'brush';
export type ViewBox = { x: number; y: number; w: number; h: number };

export const TILE_COLORS: Record<string, string> = {
  assigned: '#9ca3af', completed: '#16a34a', dirty: '#f59e0b',
};

// One committed annotation rendered as the appropriate SVG primitive.
export const AnnotationShape: Component<{
  ann: CanvasAnnotation; selected: boolean; onSelect: () => void;
}> = (props) => {
  const stroke = () => (props.selected ? '#dc2626' : '#2563eb');
  const onDown = (e: PointerEvent) => { e.stopPropagation(); props.onSelect(); };
  return (
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
  );
};

// Clamp a viewport to the image bounds (used when persisting an annotation's viewport).
export function clampRect(v: ViewBox, w: number, h: number): Rect {
  const x = Math.max(0, Math.round(v.x));
  const y = Math.max(0, Math.round(v.y));
  return { x, y, w: Math.min(w - x, Math.round(v.w)), h: Math.min(h - y, Math.round(v.h)) };
}
