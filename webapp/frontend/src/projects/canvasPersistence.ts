import type { Accessor } from 'solid-js';
import { projectsApi } from './api';
import type { CanvasAnnotation, CanvasImage, CreateAnnotationResult, TileStateUpdate } from './api';
import type { EditStrokeResult } from './canvasStrokeEditApi';
import { clampRect, mergeTileStates, strokeOutline } from './canvasShapes';
import { polylineOutline } from './canvasPolylineGeometry';
import type { ViewBox } from './canvasShapes';
import type { createCanvasHistory } from './canvasHistory';
import type { CanvasSocket } from './canvasSocket';
import { createPolylineSession } from './canvasPolylinePersist';

export interface CanvasPersistenceOpts {
  image: Accessor<CanvasImage | undefined>;
  getProjectId: () => string | undefined;
  annotator: () => string;
  selClass: Accessor<string>;
  vb: Accessor<ViewBox>;
  updateImg: (fn: (im: CanvasImage) => CanvasImage) => void;
  history: ReturnType<typeof createCanvasHistory>;
  /** Phase 1 (feat/annotation-ws): the ONE ordered channel every create/edit/reverse op
   * flows through. Sharing it across commit/editStroke/polylineSession/history is what
   * dissolves the polyline persist-vs-undo race — see canvasSocket.ts. */
  socket: CanvasSocket;
}

/**
 * Server round-trips for the canvas: paint-stroke commit + brush-eraser + stroke-vertex
 * edit + relabel. Split out of CanvasScreen (200-line cap). Phase 1 routes create/edit
 * over `socket` (single ordered channel) while erase/relabel stay on REST (out of scope).
 */
export function createCanvasPersistence(o: CanvasPersistenceOpts) {
  // BUGS #16: a mutation that lands in an already-completed tile re-opens it server-side.
  const applyTileStates = (updates: TileStateUpdate[]) =>
    o.updateImg((im) => ({ ...im, tiles: mergeTileStates(im.tiles, updates) }));
  const pushAnnotation = (ann: CanvasAnnotation) =>
    o.updateImg((im) => ({ ...im, annotations: [...im.annotations, ann] }));
  const removeAnnotations = (ids: string[]) =>
    o.updateImg((im) => ({ ...im, annotations: im.annotations.filter((a) => !ids.includes(a.id)) }));

  // ── Body builders ──────────────────────────────────────────────────────────────────
  // Kept as pure funcs so both the socket path (commit/editStroke/polylineSession) and
  // any redo re-issue use IDENTICAL wire bodies (server contract unchanged).
  const buildCreateBody = (kind: string, points: number[][], passNo?: number,
                            strokeWidth?: number, tool?: string) => {
    const im = o.image();
    const outline = (kind === 'stroke' && strokeWidth != null)
      ? (tool === 'polyline'
          ? polylineOutline(points, strokeWidth)
          : strokeOutline(points, strokeWidth))
      : undefined;
    return {
      imageId: im!.imageId, annotator: o.annotator(), kind, points, passNo,
      label: o.selClass(), viewport: clampRect(o.vb(), im!.width, im!.height),
      strokeWidth: kind === 'stroke' ? strokeWidth : undefined,
      outline,
      tool: kind === 'stroke' ? tool : undefined,
    };
  };
  const buildEditBody = (strokeId: string, tool: string, points: number[][], strokeWidth: number) => {
    const outline = tool === 'polyline'
      ? polylineOutline(points, strokeWidth)
      : strokeOutline(points, strokeWidth);
    return { strokeId, points, strokeWidth, outline };
  };

  // ── Delta appliers (splice into view + push history) ───────────────────────────────
  const applyCreate = (ann: CreateAnnotationResult, body: unknown) => {
    pushAnnotation(ann);
    applyTileStates(ann.tileStates ?? []);
    if (ann.consumedAnnotationIds.length) {
      // Fused with ≥1 existing mask: originals soft-deleted server-side — drop them
      // and record a compound `merge` history entry (see canvasHistory.ts) so undo
      // can resurrect + repoint them; redo re-POSTs `body` as-is.
      removeAnnotations(ann.consumedAnnotationIds);
      o.history.push({ kind: 'merge', ann, strokeId: ann.createdStrokeId,
        consumedGroups: ann.consumedGroups, redoBody: body as never });
    } else {
      o.history.push({ kind: 'draw', ann });
    }
  };
  const applyEdit = (r: EditStrokeResult, strokeId: string, body: unknown) => {
    o.updateImg((im) => ({
      ...im,
      annotations: [
        ...im.annotations.filter((a) => !r.deletedAnnotationIds.includes(a.id)),
        ...r.created,
      ],
      tiles: mergeTileStates(im.tiles, r.tileStates),
    }));
    o.history.push({ kind: 'edit', strokeId, before: r.before,
      deletedGroups: r.deletedGroups, created: r.created, redoBody: body as never });
  };

  // Brush eraser: one drag → one REST call that soft-deletes every mask the swept area
  // intersects; single Ctrl+Z restores all. Not routed through the socket (Phase 1 op
  // set is create/edit/reverse only) — no ordering conflict with the polyline race path.
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

  // Compound labels: label-only PATCH via REST (out of Phase 1 scope). See
  // canvasHistory.ts `relabel` action for undo/redo.
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

  // Create/paint commit — routed over the socket. Erase stays REST (out of scope).
  const commit = async (kind: string, points: number[][], passNo?: number,
                         strokeWidth?: number, tool?: string):
      Promise<{ createdStrokeId: string } | null> => {
    if (kind === 'erase') { void eraseStroke(points, strokeWidth ?? 1); return null; }
    const im = o.image(); const pid = o.getProjectId();
    if (!im || !pid) return null;
    const body = buildCreateBody(kind, points, passNo, strokeWidth, tool);
    const r = await o.socket.enqueue<CreateAnnotationResult | null>(async (send) => {
      const ack = await send<CreateAnnotationResult>('create', body);
      if (!ack.ok) { alert(ack.message); return null; }
      applyCreate(ack.result, body);
      return ack.result;
    });
    return r ? { createdStrokeId: r.createdStrokeId } : null;
  };

  // Stroke-vertex edit — routed over the socket. Same body shape the PATCH endpoint uses,
  // just carried as an op frame. History push happens inside applyEdit.
  const editStroke = async (strokeId: string, tool: string, points: number[][], strokeWidth: number) => {
    const pid = o.getProjectId();
    if (!pid) return;
    const body = buildEditBody(strokeId, tool, points, strokeWidth);
    await o.socket.enqueue(async (send) => {
      const ack = await send<EditStrokeResult>('edit', body);
      if (!ack.ok) { alert(ack.message); return; }
      applyEdit(ack.result, strokeId, body);
    });
  };

  // Polyline per-click session — same socket, same body builders + delta appliers.
  const polySession = createPolylineSession({
    socket: o.socket,
    buildCreatePayload: (points, strokeWidth) =>
      buildCreateBody('stroke', points, 1, strokeWidth, 'polyline'),
    buildEditPayload:   (strokeId, points, strokeWidth) =>
      buildEditBody(strokeId, 'polyline', points, strokeWidth),
    applyCreate,
    applyEdit,
  });

  return { commit, relabel, editStroke,
    polylineStep: polySession.step, resetPolyline: polySession.reset };
}
