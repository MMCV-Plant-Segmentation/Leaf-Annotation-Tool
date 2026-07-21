import { createMemo, createSignal, type Accessor } from 'solid-js';
import type { CanvasImage } from './canvasApi';
import { buildVertexIndex, type VertexIndex } from './canvasSnap';

/**
 * Draw-time vertex snapping — PHASE 2b (t50) glue: the reactive bits CanvasScreen
 * needs to drive `polylineClick`'s snap opts, split out so CanvasScreen.tsx (at the
 * 200-line cap) stays thin. Rebuilt whenever the image's annotations change (loaded
 * OR freshly drawn), so a just-created vertex is immediately snappable.
 */
export function createSnapIndex(image: Accessor<CanvasImage | undefined>): Accessor<VertexIndex> {
  return createMemo(() =>
    buildVertexIndex((image()?.annotations ?? []).flatMap((a) => a.strokes ?? [])));
}

/** t80: the brush-side snap reach is the brush RADIUS = size / 2 (size is a diameter).
 * resolveSnap combines this with each vertex's own radius as max(brushRadius, vertexRadius),
 * so a tiny brush still snaps onto a fat existing point. Click coords are already image-space
 * (same space as stored vertices) — no zoom scaling. */
export const snapRadiusFromBrush = (brushSize: number): number => brushSize / 2;

/** Bundles everything CanvasScreen needs to wire polyline snapping into the interaction +
 * keyboard layers in one call (keeps CanvasScreen.tsx, at the 200-line cap, thin):
 * the parallel per-point vertex-ref draft signal (reset alongside `draft` on ESC/tool-
 * switch) + the reactive snap index + the image-space snap radius accessor. */
export function createPolylineSnapState(image: Accessor<CanvasImage | undefined>, brushSize: Accessor<number>) {
  const [draftRefs, setDraftRefs] = createSignal<(string | null)[]>([]);
  return { draftRefs, setDraftRefs, snapIndex: createSnapIndex(image),
    snapRadiusImg: () => snapRadiusFromBrush(brushSize()) };
}
