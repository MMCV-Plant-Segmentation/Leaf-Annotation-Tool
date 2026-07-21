/**
 * a11y #40 v1b: draggable vertex handles for the selected stroke mask.
 *
 * When a stroke annotation is selected (Select tool), one dot is rendered at every
 * stored input point across the mask's member strokes. Pointer-down on a dot begins a
 * drag (pointer captured on the circle so we keep tracking past the SVG edge);
 * pointer-move updates a LIVE preview outline of the affected stroke (polyline →
 * polylineOutline, brush → perfect-freehand strokeOutline), and pointer-up commits
 * the moved points via `onCommit` which round-trips through the PATCH endpoint (see
 * canvasPersistence.ts `editStroke`).
 *
 * `stopPropagation` on every pointer handler so the surrounding SVG's onPointerDown
 * (select/pan) never fires when the user grabs a handle.
 */
import { type Component, For, Show, createMemo, createSignal } from 'solid-js';
import type { CanvasAnnotation } from './canvasApi';
import { annStrokes, collapseOnAdjacent, handleRadiusImg, moveVertex, sharedVertexId } from './canvasVertexEdit';
import { polylineOutline } from './canvasPolylineGeometry';
import { ringsToPath, strokeOutline } from './canvasShapes';
import { t } from '../i18n/catalog';
import * as styles from './VertexHandles.css';

// Handle visuals — inline (data-viz colour) so the .css.ts stays hex/rgb-free.
const HANDLE_FILL = '#facc15';        // matches SelectionHighlight's stroke
const HANDLE_STROKE = '#1e3a8a';      // dark halo — reads on both light & dark leaves
const PREVIEW_FILL = 'rgba(37,99,235,0.35)';
const PREVIEW_STROKE = '#1e3a8a';
const HANDLE_SCREEN_PX = 6;            // ~6 screen px radius — grabbable at any zoom

type Drag = { strokeId: string; index: number; x: number; y: number; tool: string;
  points: number[][]; strokeWidth: number };

export type VertexHandlesProps = {
  ann: CanvasAnnotation;
  /** Image-space units per screen pixel (drives the handle radius so it stays a
   *  CONSTANT screen size across zoom — see canvasVertexEdit.handleRadiusImg). */
  scale: () => number;
  /** Screen (client) coords → image coords, from canvasInteraction.toImage. */
  toImage: (clientX: number, clientY: number) => [number, number];
  /** Called on drop with the new points (fresh outline is recomputed inside
   *  canvasPersistence.editStroke; here we only ship the vertices). */
  onCommit: (strokeId: string, tool: string, points: number[][], strokeWidth: number) => void;
  /** t50 phase 3b: every loaded annotation (not just the selected mask) — needed to
   *  detect whether the grabbed handle's vertex is SHARED (see canvasVertexEdit.sharedVertexId). */
  allAnnotations: () => CanvasAnnotation[];
  /** Called instead of onCommit when the dropped vertex is SHARED — routes to the
   *  move op so every mark sharing it follows (canvasPersistence.moveSharedVertex). */
  onMoveSharedVertex: (vertexId: string, before: { x: number; y: number }, after: { x: number; y: number }) => void;
};

export const VertexHandles: Component<VertexHandlesProps> = (props) => {
  const [drag, setDrag] = createSignal<Drag | null>(null);
  const radius = createMemo(() => handleRadiusImg(HANDLE_SCREEN_PX, props.scale()));
  const strokes = createMemo(() => annStrokes(props.ann));

  const beginDrag = (e: PointerEvent, strokeId: string, index: number,
      tool: string, points: number[][], strokeWidth: number) => {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    const [ix, iy] = props.toImage(e.clientX, e.clientY);
    setDrag({ strokeId, index, x: ix, y: iy, tool, points, strokeWidth });
  };
  const updateDrag = (e: PointerEvent) => {
    if (!drag()) return;
    e.stopPropagation();
    const [ix, iy] = props.toImage(e.clientX, e.clientY);
    setDrag((d) => (d ? { ...d, x: ix, y: iy } : d));
  };
  const endDrag = (e: PointerEvent) => {
    const d = drag(); if (!d) return;
    e.stopPropagation();
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    setDrag(null);
    // t66: dropped onto an ADJACENT vertex of the same stroke → collapse the duplicate
    // (remove the dragged vertex) via the per-stroke edit. Takes precedence over the
    // shared-move: the intent is to delete a redundant vertex, not to drag the shared one.
    const merged = collapseOnAdjacent(d.points, d.index, d.x, d.y, radius());
    if (merged) {
      props.onCommit(d.strokeId, d.tool, merged, d.strokeWidth);
      return;
    }
    // t50 phase 3b: a SHARED (snapped) vertex routes to the move op so every mark
    // sharing it follows the drag; an unshared vertex keeps the per-stroke edit.
    const vid = sharedVertexId(props.allAnnotations(), d.strokeId, d.index);
    if (vid) {
      const [bx, by] = d.points[d.index];
      props.onMoveSharedVertex(vid, { x: bx, y: by }, { x: d.x, y: d.y });
      return;
    }
    const moved = moveVertex(d.points, d.index, d.x, d.y);
    props.onCommit(d.strokeId, d.tool, moved, d.strokeWidth);
  };

  // Live preview: rebuild the affected stroke's outline as the vertex moves.
  const previewPath = createMemo(() => {
    const d = drag(); if (!d) return '';
    const moved = moveVertex(d.points, d.index, d.x, d.y);
    const outline = d.tool === 'polyline'
      ? polylineOutline(moved, d.strokeWidth)
      : strokeOutline(moved, d.strokeWidth);
    return outline.length ? ringsToPath([outline]) : '';
  });

  return (
    <>
      <Show when={previewPath()}>
        <path d={previewPath()} fill={PREVIEW_FILL} fill-rule="evenodd"
          stroke={PREVIEW_STROKE} stroke-width="1.5"
          vector-effect="non-scaling-stroke" pointer-events="none" />
      </Show>
      <For each={strokes()}>
        {(s) => (
          <For each={s.points}>
            {([x, y], i) => {
              // While dragging THIS vertex, render it at its live position instead of stored.
              const isDragging = () => {
                const d = drag(); return !!(d && d.strokeId === s.id && d.index === i());
              };
              const cx = () => { const d = drag(); return isDragging() && d ? d.x : x; };
              const cy = () => { const d = drag(); return isDragging() && d ? d.y : y; };
              return (
                <circle class={styles.handle} data-testid="vertex-handle"
                  cx={cx()} cy={cy()} r={radius()}
                  fill={HANDLE_FILL} stroke={HANDLE_STROKE} stroke-width="1.5"
                  vector-effect="non-scaling-stroke"
                  aria-label={t('canvas.vertexHandle')}
                  onPointerDown={(e) => beginDrag(e, s.id, i(), s.tool, s.points, s.strokeWidth)}
                  onPointerMove={updateDrag}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag} />
              );
            }}
          </For>
        )}
      </For>
    </>
  );
};
