import type { Accessor } from 'solid-js';
import { projectsApi } from './api';
import type { CanvasAnnotation, CanvasImage, CanvasLesion, TileStateUpdate } from './api';
import { clampRect, mergeTileStates, strokeOutline } from './canvasShapes';
import type { ViewBox } from './canvasShapes';
import type { createCanvasHistory } from './canvasHistory';

export interface CanvasPersistenceOpts {
  image: Accessor<CanvasImage | undefined>;
  getProjectId: () => string | undefined;
  annotator: () => string;
  selClass: Accessor<string>;
  vb: Accessor<ViewBox>;
  updateImg: (fn: (im: CanvasImage) => CanvasImage) => void;
  history: ReturnType<typeof createCanvasHistory>;
}

/**
 * Server round-trips for the canvas: paint-stroke commit and brush-eraser commit. Split out
 * of CanvasScreen (≤200-line limit) — pure glue between the pointer gesture (canvasInteraction)
 * and the mutate endpoints, with the resulting delta applied via `updateImg`/`history`.
 */
export function createCanvasPersistence(o: CanvasPersistenceOpts) {
  const applyLesions = (ls: CanvasLesion[]) => o.updateImg((im) => ({ ...im, lesions: ls }));
  // BUGS #16: a mutation that lands in an already-completed tile re-opens it server-side.
  const applyTileStates = (updates: TileStateUpdate[]) =>
    o.updateImg((im) => ({ ...im, tiles: mergeTileStates(im.tiles, updates) }));
  const pushAnnotation = (ann: CanvasAnnotation) =>
    o.updateImg((im) => ({ ...im, annotations: [...im.annotations, ann] }));

  // Brush eraser: one drag → one server call that soft-deletes every one of THIS
  // annotator's live strokes the swept area intersects, then one `erase` history push
  // (single Ctrl+Z restores all of them). The eraser paints nothing of its own.
  const eraseStroke = async (points: number[][], strokeWidth: number) => {
    const im = o.image(); const pid = o.getProjectId();
    if (!im || !pid) return;
    try {
      const outline = strokeOutline(points, strokeWidth);
      const r = await projectsApi.eraseStroke(pid, {
        imageId: im.imageId, annotator: o.annotator(), points, strokeWidth, outline,
      });
      const erased = im.annotations.filter((a) => r.deletedIds.includes(a.id));
      o.history.applyErase(erased, r.lesions, r.tileStates);
    } catch (ex) {
      alert(ex instanceof Error ? ex.message : 'Erase failed');
    }
  };

  const commit = async (kind: string, points: number[][], passNo?: number, strokeWidth?: number) => {
    if (kind === 'erase') return void eraseStroke(points, strokeWidth ?? 1);
    const im = o.image(); const pid = o.getProjectId();
    if (!im || !pid) return;
    try {
      // Compute the perfect-freehand outline polygon for stroke commits so the server
      // stores and uses it for lesion geometry (fills loops, matches rendered shape).
      const outline = (kind === 'stroke' && strokeWidth != null)
        ? strokeOutline(points, strokeWidth)
        : undefined;
      const ann = await projectsApi.createAnnotation(pid, {
        imageId: im.imageId, annotator: o.annotator(), kind, points, passNo,
        label: o.selClass(), viewport: clampRect(o.vb(), im.width, im.height),
        strokeWidth: kind === 'stroke' ? strokeWidth : undefined,
        outline,
      });
      pushAnnotation(ann);
      applyLesions(ann.lesions ?? []);
      applyTileStates(ann.tileStates ?? []);
      o.history.push({ kind: 'draw', ann });
    } catch (ex) {
      alert(ex instanceof Error ? ex.message : 'Save failed');
    }
  };

  return { commit };
}
