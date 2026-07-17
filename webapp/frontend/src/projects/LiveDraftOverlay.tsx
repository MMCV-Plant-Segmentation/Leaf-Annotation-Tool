import { type Component, Show } from 'solid-js';
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
  polylineDash: '6 4',
};

/** Live in-progress brush/eraser stroke + hover-radius preview and the polyline preview.
 *
 * For polyline (per-click rebuild, 2026-07-13): every click persists+fuses immediately, so the
 * PLACED vertices already show through the normal AnnotationShape rendering — we must NOT redraw
 * the whole draft here (it would double-render the committed strokes). The only ephemeral things
 * are: a cursor circle showing the brush width (like brush/eraser, so the user sees thickness
 * before dropping a vertex), and the PENDING segment (last placed vertex → cursor) drawn as the
 * SAME width-buffered outline that will be committed on the next click (its real thickness, not a
 * hairline) plus a dashed centerline as a direction cue. ESC/tool-switch clears the draft. */
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
    {/* Polyline cursor-width preview (a11y #40): mirrors the brush/eraser cursor circle so the
        user SEES the stroke thickness before dropping a vertex. Shown whenever polyline is
        active + hovering (no draft required). */}
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
    {/* Per-click model: placed clicks are ALREADY committed masks (AnnotationShape), so the only
        ephemeral thing is the PENDING segment (last placed vertex → cursor) — the width-buffered
        band (its committed thickness) plus a dashed centerline. We do NOT re-render the whole draft
        as a thick shape / vertex dots — that would double-render the committed strokes. */}
    <Show when={props.tool === 'polyline' && props.draft.length > 0 && props.hover}>
      {(c) => {
        // Reactive: the <Show> body runs once (the condition stays truthy as vertices are added),
        // so `last` must be an accessor — a captured value would freeze on the FIRST vertex and the
        // rubber band would anchor there instead of the most-recently-placed one.
        const last = () => props.draft[props.draft.length - 1];
        const bandPath = () => ringsToPath([polylineOutline([last(), c()], props.brushSize)]);
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
              x1={last()[0]} y1={last()[1]} x2={c()[0]} y2={c()[1]}
              stroke={LIVE_DRAFT.brushStroke} stroke-width={LIVE_DRAFT.strokeWidth}
              stroke-dasharray={LIVE_DRAFT.polylineDash}
              vector-effect="non-scaling-stroke" pointer-events="none" />
          </>
        );
      }}
    </Show>
  </>
);
