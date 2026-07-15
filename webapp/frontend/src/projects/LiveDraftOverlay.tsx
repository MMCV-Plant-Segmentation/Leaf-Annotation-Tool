import { type Component, For, Show } from 'solid-js';
import { buildStrokePath, ringsToPath, type Tool } from './canvasShapes';
import { polylineOutline } from './canvasPolylineGeometry';

// Accessibility-tuned colours for the *live* brush/eraser/polyline draft + hover preview —
// deliberately louder than the committed-stroke rendering (AnnotationShape), since a
// low-vision user needs to see her own in-progress stroke while drawing. A white halo
// is drawn under a dark-toned outline so the shape reads against both light and dark
// leaf backgrounds. Kept as one object so Christian can retune by eye.
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
  polylineVertexR: 3,
  polylineDash: '6 4',
};

/** Live in-progress brush/eraser/polyline stroke + hover-radius preview. Rendered on
 * top of everything else while drawing; not shown for committed strokes.
 *
 * For a polyline (a11y click-brush): the placed vertices are shown as solid dots, the
 * committed segments as a solid line, and a DASHED rubber-band segment previews the
 * next segment from the last vertex to the current cursor. */
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
    {/* Polyline hover-radius preview (a11y #40): mirrors the brush/eraser cursor circle so
        the user SEES the stroke thickness before dropping a vertex — a polyline is a brush
        driven by clicks, so its preview should convey width the same way. Shown whenever
        polyline is active + hovering (no draft required), same as brush/eraser. */}
    <Show when={props.tool === 'polyline' && props.hover}>
      {(c) => (
        <>
          <circle cx={c()[0]} cy={c()[1]} r={props.brushSize / 2} fill="none"
            stroke={LIVE_DRAFT.haloColor} stroke-width={LIVE_DRAFT.previewHaloWidth}
            vector-effect="non-scaling-stroke" pointer-events="none" />
          <circle data-testid="polyline-cursor-preview"
            cx={c()[0]} cy={c()[1]} r={props.brushSize / 2} fill="none"
            stroke={LIVE_DRAFT.brushStroke} stroke-width={LIVE_DRAFT.previewStrokeWidth}
            vector-effect="non-scaling-stroke" pointer-events="none" />
        </>
      )}
    </Show>
    <Show when={props.tool === 'polyline' && props.draft.length > 0}>
      {/* The THICK filled shape the commit will store (polylineOutline == the sent outline),
          so the preview matches the stored geometry exactly. nonzero fill so a reflex/looped
          ring still fills. Vertex dots + a dashed rubber-band preview the pending segment. */}
      <path data-testid="polyline-live"
        d={ringsToPath([polylineOutline(props.draft, props.brushSize)])} fill="none"
        stroke={LIVE_DRAFT.haloColor} stroke-width={LIVE_DRAFT.haloWidth}
        vector-effect="non-scaling-stroke" pointer-events="none" />
      <path d={ringsToPath([polylineOutline(props.draft, props.brushSize)])} fill-rule="nonzero"
        fill={LIVE_DRAFT.brushFill} stroke={LIVE_DRAFT.brushStroke} stroke-width={LIVE_DRAFT.strokeWidth}
        vector-effect="non-scaling-stroke" pointer-events="none" />
      <For each={props.draft}>{(pt) => (
        <circle cx={pt[0]} cy={pt[1]} r={LIVE_DRAFT.polylineVertexR}
          fill={LIVE_DRAFT.brushStroke} stroke={LIVE_DRAFT.haloColor} stroke-width={1}
          vector-effect="non-scaling-stroke" pointer-events="none" />
      )}</For>
      <Show when={props.hover}>{(c) => {
        const last = props.draft[props.draft.length - 1];
        // Pending segment (last placed vertex → cursor) rendered as the SAME width-buffered
        // outline that would be committed on the next click — so the user sees the actual
        // thickness of the next segment, not just a hairline direction cue. `polylineOutline`
        // handles the degenerate cursor-on-vertex case by returning a disc. Halo goes under
        // so the shape reads against both light and dark leaf backgrounds. The existing dashed
        // centerline stays on top as a direction guide.
        const bandPath = () => ringsToPath([polylineOutline([last, c()], props.brushSize)]);
        return (
          <>
            <path d={bandPath()} fill="none"
              stroke={LIVE_DRAFT.haloColor} stroke-width={LIVE_DRAFT.haloWidth}
              vector-effect="non-scaling-stroke" pointer-events="none" />
            <path data-testid="polyline-width-preview" d={bandPath()} fill-rule="nonzero"
              fill={LIVE_DRAFT.brushFill} stroke={LIVE_DRAFT.brushStroke}
              stroke-width={LIVE_DRAFT.strokeWidth}
              vector-effect="non-scaling-stroke" pointer-events="none" />
            <line data-testid="polyline-rubberband"
              x1={last[0]} y1={last[1]} x2={c()[0]} y2={c()[1]}
              stroke={LIVE_DRAFT.brushStroke} stroke-width={LIVE_DRAFT.strokeWidth}
              stroke-dasharray={LIVE_DRAFT.polylineDash}
              vector-effect="non-scaling-stroke" pointer-events="none" />
          </>
        );
      }}</Show>
    </Show>
  </>
);
