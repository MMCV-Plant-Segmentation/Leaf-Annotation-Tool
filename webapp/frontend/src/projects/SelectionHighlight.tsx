import { type Component, Show } from 'solid-js';
import type { CanvasAnnotation } from './api';
import { ringsToPath } from './canvasShapes';

// Selection highlight: a bright dashed outline drawn over the selected lesion so the
// user can clearly see which lesion the selection tool has picked. Data-viz colours
// (not theme tokens) are kept inline here per the FE colour-token convention.
export const SELECT_HIGHLIGHT = {
  halo: '#ffffff',
  stroke: '#facc15',
  width: 3.5,
  dash: '8 4',
};

/** Outline the selected annotation's geometry. pointer-events:none so it never
 * steals clicks from the lesion beneath it (the SVG-level handler hit-tests). */
export const SelectionHighlight: Component<{ ann: CanvasAnnotation }> = (props) => (
  <Show when={props.ann.kind === 'stroke'} fallback={
    <Show when={props.ann.kind === 'point'} fallback={
      <Show when={props.ann.kind === 'line'} fallback={
        <polygon points={props.ann.points.map((p) => p.join(',')).join(' ')} fill="none"
          stroke={SELECT_HIGHLIGHT.halo} stroke-width={SELECT_HIGHLIGHT.width + 2}
          vector-effect="non-scaling-stroke" pointer-events="none" />
      }>
        <polyline points={props.ann.points.map((p) => p.join(',')).join(' ')} fill="none"
          stroke={SELECT_HIGHLIGHT.halo} stroke-width={SELECT_HIGHLIGHT.width + 2}
          vector-effect="non-scaling-stroke" pointer-events="none" />
      </Show>
    }>
      <circle cx={props.ann.points[0][0]} cy={props.ann.points[0][1]} r="9"
        fill="none" stroke={SELECT_HIGHLIGHT.halo} stroke-width={SELECT_HIGHLIGHT.width + 2}
        vector-effect="non-scaling-stroke" pointer-events="none" />
    </Show>
  }>
    <Show when={props.ann.rings.length > 0}>
      <path d={ringsToPath(props.ann.rings)} fill="none" fill-rule="evenodd"
        stroke={SELECT_HIGHLIGHT.halo} stroke-width={SELECT_HIGHLIGHT.width + 2}
        stroke-dasharray={SELECT_HIGHLIGHT.dash}
        vector-effect="non-scaling-stroke" pointer-events="none" />
      <path d={ringsToPath(props.ann.rings)} fill="none" fill-rule="evenodd"
        stroke={SELECT_HIGHLIGHT.stroke} stroke-width={SELECT_HIGHLIGHT.width}
        stroke-dasharray={SELECT_HIGHLIGHT.dash}
        vector-effect="non-scaling-stroke" pointer-events="none" />
    </Show>
  </Show>
);
