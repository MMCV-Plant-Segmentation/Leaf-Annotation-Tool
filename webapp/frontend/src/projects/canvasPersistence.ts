import type { Accessor } from 'solid-js';
import { projectsApi } from './api';
import type { CanvasAnnotation, CanvasImage, TileStateUpdate } from './api';
import { clampRect, mergeTileStates, strokeOutline } from './canvasShapes';
import { polylineOutline } from './canvasPolylineGeometry';
import type { ViewBox } from './canvasShapes';
import type { createCanvasHistory } from './canvasHistory';
import { createPolylineSession } from './canvasPolylinePersist';

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

  const commit = async (kind: string, points: number[][], passNo?: number, strokeWidth?: number, tool?: string):
      Promise<{ createdStrokeId: string } | null> => {
    if (kind === 'erase') { void eraseStroke(points, strokeWidth ?? 1); return null; }
    const im = o.image(); const pid = o.getProjectId();
    if (!im || !pid) return null;
    try {
      // Compute the exact stroke-outline polygon FE-side so the server stores + uses it for
      // the fused mask's geometry (fills loops, matches the rendered shape). Brush → perfect-
      // freehand; polyline → straight-segment buffer (round joins/caps). Sending it for BOTH
      // means what gets stored is exactly what the FE drew (no BE re-derivation drift), and
      // redo (canvasHistory.ts) can re-POST this exact body.
      const outline = (kind === 'stroke' && strokeWidth != null)
        ? (tool === 'polyline'
            ? polylineOutline(points, strokeWidth)
            : strokeOutline(points, strokeWidth))
        : undefined;
      const body = {
        imageId: im.imageId, annotator: o.annotator(), kind, points, passNo,
        label: o.selClass(), viewport: clampRect(o.vb(), im.width, im.height),
        strokeWidth: kind === 'stroke' ? strokeWidth : undefined,
        outline,
        tool: kind === 'stroke' ? tool : undefined,
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
      return { createdStrokeId: ann.createdStrokeId };
    } catch (ex) {
      alert(ex instanceof Error ? ex.message : 'Save failed');
      return null;
    }
  };

  // a11y #40 v1b: commit a stroke-vertex edit. Recompute the outline from the moved
  // points (polyline vs. brush) so the STORED geometry matches the LIVE preview, PATCH
  // /strokes/<id>, splice the response into the view, and push an `edit` history entry
  // (canvasHistory.ts) whose reversal descriptor is everything undo needs.
  const editStroke = async (strokeId: string, tool: string, points: number[][], strokeWidth: number) => {
    const pid = o.getProjectId();
    if (!pid) return;
    try {
      const outline = tool === 'polyline'
        ? polylineOutline(points, strokeWidth)
        : strokeOutline(points, strokeWidth);
      const body = { points, strokeWidth, outline };
      const r = await projectsApi.editStroke(pid, strokeId, body);
      o.updateImg((im) => ({
        ...im,
        annotations: [
          ...im.annotations.filter((a) => !r.deletedAnnotationIds.includes(a.id)),
          ...r.created,
        ],
        tiles: mergeTileStates(im.tiles, r.tileStates),
      }));
      o.history.push({ kind: 'edit', strokeId, before: r.before,
        deletedGroups: r.deletedGroups, created: r.created, redoBody: body });
    } catch (ex) {
      alert(ex instanceof Error ? ex.message : 'Edit failed');
    }
  };

  // a11y #40 per-click rebuild (Christian, 2026-07-13): polyline persistence session —
  // each click either creates the annotation (1st click) or editStrokes it (subsequent),
  // so the mask exists after the FIRST click and grows one vertex at a time. The session
  // reuses commit/editStroke above; history entries flow the standard draw/merge/edit
  // paths, so Ctrl+Z peels one click at a time (delete → resurrect → reverse-edit).
  const polySession = createPolylineSession({
    create: async (points, strokeWidth) => {
      const r = await commit('stroke', points, 1, strokeWidth, 'polyline');
      return r ? r.createdStrokeId : null;
    },
    extend: async (strokeId, points, strokeWidth) => {
      await editStroke(strokeId, 'polyline', points, strokeWidth);
    },
  });

  return { commit, relabel, editStroke,
    polylineStep: polySession.step, resetPolyline: polySession.reset };
}
