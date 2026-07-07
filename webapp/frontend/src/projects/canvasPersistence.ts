import type { Accessor } from 'solid-js';
import { projectsApi } from './api';
import type { CanvasAnnotation, CanvasImage, TileStateUpdate } from './api';
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
  // BUGS #16: a mutation that lands in an already-completed tile re-opens it server-side.
  const applyTileStates = (updates: TileStateUpdate[]) =>
    o.updateImg((im) => ({ ...im, tiles: mergeTileStates(im.tiles, updates) }));
  const pushAnnotation = (ann: CanvasAnnotation) =>
    o.updateImg((im) => ({ ...im, annotations: [...im.annotations, ann] }));
  const removeAnnotations = (ids: string[]) =>
    o.updateImg((im) => ({ ...im, annotations: im.annotations.filter((a) => !ids.includes(a.id)) }));

  // Brush eraser: one drag → one server call that soft-deletes every one of THIS
  // annotator's live annotations (whole masks, any kind) the swept area intersects, then
  // one `erase` history push (single Ctrl+Z restores all of them). The eraser paints
  // nothing of its own.
  const eraseStroke = async (points: number[][], strokeWidth: number) => {
    const im = o.image(); const pid = o.getProjectId();
    if (!im || !pid) return;
    try {
      const outline = strokeOutline(points, strokeWidth);
      const r = await projectsApi.eraseStroke(pid, {
        imageId: im.imageId, annotator: o.annotator(), points, strokeWidth, outline,
      });
      const erased = im.annotations.filter((a) => r.deletedAnnotationIds.includes(a.id));
      o.history.applyErase(erased, r.tileStates);
    } catch (ex) {
      alert(ex instanceof Error ? ex.message : 'Erase failed');
    }
  };

  // Compound labels Phase 2b: re-label the selected lesion via the same PATCH endpoint
  // point/line/polygon edits already use — now loosened server-side to also accept a
  // label-only patch on a `stroke` (painted) mask (see webapp/projects.py). Persists
  // the label + its denormalised colour/selections snapshot; the caller re-renders from
  // the returned annotation, so the lesion recolors immediately on the canvas + legend.
  //
  // Phase 2c: also pushes a `relabel` history entry (canvasHistory.ts) carrying the
  // PRIOR label alongside the new one, so Ctrl+Z/Ctrl+Shift+Z can undo/redo it via the
  // same label-only PATCH — no-op (re-picking the current label) pushes nothing.
  const relabel = async (annotationId: string, label: string) => {
    const before = o.image()?.annotations.find((a) => a.id === annotationId)?.label ?? null;
    if (before === label) return;
    try {
      const updated = await projectsApi.updateAnnotation(annotationId, { label });
      o.updateImg((im) => ({
        ...im,
        annotations: im.annotations.map((a) => a.id === annotationId ? { ...a, ...updated } : a),
      }));
      o.history.push({ kind: 'relabel', annotationId, before, after: updated.label });
    } catch (ex) {
      alert(ex instanceof Error ? ex.message : 'Relabel failed');
    }
  };

  const commit = async (kind: string, points: number[][], passNo?: number, strokeWidth?: number) => {
    if (kind === 'erase') return void eraseStroke(points, strokeWidth ?? 1);
    const im = o.image(); const pid = o.getProjectId();
    if (!im || !pid) return;
    try {
      // Compute the perfect-freehand outline polygon for stroke commits so the server
      // stores and uses it for the fused mask's geometry (fills loops, matches rendered
      // shape). Kept so redo (canvasHistory.ts) can re-POST this exact body.
      const outline = (kind === 'stroke' && strokeWidth != null)
        ? strokeOutline(points, strokeWidth)
        : undefined;
      const body = {
        imageId: im.imageId, annotator: o.annotator(), kind, points, passNo,
        label: o.selClass(), viewport: clampRect(o.vb(), im.width, im.height),
        strokeWidth: kind === 'stroke' ? strokeWidth : undefined,
        outline,
      };
      const ann = await projectsApi.createAnnotation(pid, body);
      pushAnnotation(ann);
      applyTileStates(ann.tileStates ?? []);
      if (ann.consumedAnnotationIds.length) {
        // Fused with ≥1 existing mask: those originals were soft-deleted server-side —
        // drop them from the view and record a compound `merge` history entry (see
        // canvasHistory.ts) so undo can resurrect + repoint them.
        removeAnnotations(ann.consumedAnnotationIds);
        o.history.push({
          kind: 'merge', ann, strokeId: ann.createdStrokeId,
          consumedGroups: ann.consumedGroups, redoBody: body,
        });
      } else {
        o.history.push({ kind: 'draw', ann });
      }
    } catch (ex) {
      alert(ex instanceof Error ? ex.message : 'Save failed');
    }
  };

  return { commit, relabel };
}
