import { createSignal, type Accessor, type Setter } from 'solid-js';
import type { Tool, ViewBox } from './canvasShapes';
import { polylineClick } from './canvasPolyline';

export interface CanvasInteractionOpts {
  getSvg: () => SVGSVGElement | undefined;
  vb: Accessor<ViewBox>;
  setVb: Setter<ViewBox>;
  tool: Accessor<Tool>;
  brushSize: Accessor<number>;
  setBrushSize: (s: number) => void;
  maxBrushSize: Accessor<number>;
  draft: Accessor<number[][]>;
  setDraft: Setter<number[][]>;
  commit: (kind: string, points: number[][], passNo?: number, strokeWidth?: number, tool?: string) => void;
  /** Polyline per-click hook: fires with growing point list; persistence picks create/edit. */
  polylineStep?: (points: number[][], strokeWidth: number) => void;
  onSelect?: (imgPoint: [number, number]) => void; }

export interface CanvasInteraction {
  toImage: (clientX: number, clientY: number) => [number, number];
  onWheel: (e: WheelEvent) => void;
  onPointerDown: (e: PointerEvent) => void;
  onPointerMove: (e: PointerEvent) => void;
  onPointerUp: (e: PointerEvent) => void;
  onPointerLeave: () => void;
  handleKeyDown: (e: KeyboardEvent) => void;
  handleKeyUp: (e: KeyboardEvent) => void;
  isSpaceDown: Accessor<boolean>;
  hoverImg: Accessor<[number, number] | null>;
  finishDraft: () => void;
}

// Pointer/zoom/draft controller for the annotation canvas — pure closure over the signals.
export function createCanvasInteraction(o: CanvasInteractionOpts): CanvasInteraction {
  // Space-bar pan state (reactive so SVG cursor can respond)
  const [spaceDown, setSpaceDown] = createSignal(false);
  const [hoverImg, setHoverImg] = createSignal<[number, number] | null>(null);
  let spacePanRef: { x: number; y: number; vb: ViewBox } | null = null;

  // Mid-stroke pan lock (B §D: all pan disabled while pointer is down drawing)
  let strokeInProgress = false;
  let panDragging = false;
  let lastPanClient: { x: number; y: number } | null = null;

  // Multi-touch tracking for two-finger pinch (§E)
  type TouchPt = { clientX: number; clientY: number; imgX: number; imgY: number };
  const touches = new Map<number, TouchPt>();
  let pinchStart: { dist: number; midImgX: number; midImgY: number; vb: ViewBox } | null = null;

  const toImage = (clientX: number, clientY: number): [number, number] => { // client px → image px via CTM
    const ctm = o.getSvg()!.getScreenCTM();
    if (!ctm) return [clientX, clientY];
    return [(clientX - ctm.e) / ctm.a, (clientY - ctm.f) / ctm.d];
  };

  const clampSize = (s: number) => Math.max(1, Math.min(o.maxBrushSize(), Math.round(s)));

  // Multiplicative brush resize for fine low-end control; used by scroll wheel.
  const stepSize = (dir: 1 | -1) => {
    const cur = o.brushSize();
    o.setBrushSize(dir > 0 ? clampSize(Math.max(cur + 1, Math.round(cur * 1.15))) : clampSize(Math.min(cur - 1, Math.round(cur / 1.15))));
  };

  const panBy = (dClientX: number, dClientY: number) => {
    const ctm = o.getSvg()!.getScreenCTM();
    if (!ctm) return;
    o.setVb((v) => ({ ...v, x: v.x - dClientX / ctm.a, y: v.y - dClientY / ctm.d }));
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      // Ctrl/Cmd+scroll → zoom to cursor (always; §C; "zoom need not be locked" per §D)
      const [ix, iy] = toImage(e.clientX, e.clientY);
      const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      o.setVb((v) => {
        const nw = v.w * factor, nh = v.h * factor;
        return { x: ix - (ix - v.x) * (nw / v.w), y: iy - (iy - v.y) * (nh / v.h), w: nw, h: nh };
      });
      return;
    }
    if (strokeInProgress) return;  // §D: pan + size-scroll locked mid-stroke
    if ((o.tool() === 'brush' || o.tool() === 'eraser' || o.tool() === 'group' || o.tool() === 'polyline') && !e.shiftKey) {
      // Plain scroll on a sizeable tool → adjust brush size (§B); polyline shares brush's control.
      stepSize(e.deltaY > 0 ? -1 : 1);
      return;
    }
    // Shift+scroll → pan horizontal; else pan vertical (§C). Negative = natural scroll direction.
    if (e.shiftKey) { panBy(-e.deltaY, 0); } else { panBy(0, -e.deltaY); }
  };

  const onPointerDown = (e: PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const [ix, iy] = toImage(e.clientX, e.clientY);
    touches.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY, imgX: ix, imgY: iy });

    if (touches.size >= 2) {
      // Two-finger gesture starts: cancel any in-flight stroke (§E)
      if (strokeInProgress) { o.setDraft([]); strokeInProgress = false; }
      panDragging = false; spacePanRef = null;
      const pts = [...touches.values()];
      const dx = pts[1].clientX - pts[0].clientX, dy = pts[1].clientY - pts[0].clientY;
      pinchStart = {
        dist: Math.hypot(dx, dy),
        midImgX: (pts[0].imgX + pts[1].imgX) / 2,
        midImgY: (pts[0].imgY + pts[1].imgY) / 2,
        vb: o.vb(),
      };
      return;
    }

    // Space+drag → temporary pan from any tool, not mid-stroke (§C)
    if (spaceDown() && !strokeInProgress) {
      spacePanRef = { x: e.clientX, y: e.clientY, vb: o.vb() };
      return;
    }

    const tl = o.tool();
    if (tl === 'select') { o.onSelect?.([ix, iy]); return; }
    if (tl === 'pan') { panDragging = true; lastPanClient = { x: e.clientX, y: e.clientY }; return; }
    if (tl === 'brush' || tl === 'eraser' || tl === 'group') { strokeInProgress = true; o.setDraft([[ix, iy]]); return; }
    if (tl === 'polyline') { polylineClick(ix, iy, { draft: o.draft, setDraft: o.setDraft,
        brushSize: o.brushSize, polylineStep: o.polylineStep ?? (() => {}) }); return; }  // per-click persist
    o.setDraft((d) => [...d, [Math.round(ix), Math.round(iy)]]);  // polygon/line legacy vertex
  };

  const onPointerLeave = () => { setHoverImg(null); };
  const onPointerMove = (e: PointerEvent) => {
    setHoverImg(toImage(e.clientX, e.clientY));
    if (touches.has(e.pointerId)) {
      const [ix, iy] = toImage(e.clientX, e.clientY);
      touches.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY, imgX: ix, imgY: iy });
    }

    // Two-finger pinch-zoom+pan (§E)
    if (pinchStart && touches.size >= 2) {
      const pts = [...touches.values()];
      const newDist = Math.hypot(pts[1].clientX - pts[0].clientX, pts[1].clientY - pts[0].clientY);
      const scale = newDist / pinchStart.dist;
      const sv = pinchStart.vb;
      const nw = sv.w / scale, nh = sv.h / scale;
      const rect = o.getSvg()!.getBoundingClientRect();
      const smX = (pts[0].clientX + pts[1].clientX) / 2, smY = (pts[0].clientY + pts[1].clientY) / 2;
      const ns = Math.min(rect.width / nw, rect.height / nh);
      o.setVb({ x: pinchStart.midImgX - (smX - rect.left - (rect.width - nw*ns)/2) / ns, y: pinchStart.midImgY - (smY - rect.top - (rect.height - nh*ns)/2) / ns, w: nw, h: nh });
      return;
    }

    // Space-pan (§C, §D) — uses same CTM scale as panBy for 1:1 tracking.
    if (spacePanRef && !strokeInProgress) {
      const ctm = o.getSvg()!.getScreenCTM(); if (!ctm) return;
      const sv = spacePanRef.vb;
      o.setVb({ ...sv, x: sv.x - (e.clientX - spacePanRef.x) / ctm.a, y: sv.y - (e.clientY - spacePanRef.y) / ctm.d });
      return;
    }

    if (o.tool() === 'pan' && panDragging && lastPanClient) {
      panBy(e.clientX - lastPanClient.x, e.clientY - lastPanClient.y);
      lastPanClient = { x: e.clientX, y: e.clientY };
      return;
    }
    if ((o.tool() === 'brush' || o.tool() === 'eraser' || o.tool() === 'group') && strokeInProgress) {
      const [ix, iy] = toImage(e.clientX, e.clientY);
      o.setDraft((d) => [...d, [ix, iy]]);
    }
  };

  const onPointerUp = (e: PointerEvent) => {
    touches.delete(e.pointerId);
    if (touches.size < 2) pinchStart = null;

    if ((o.tool() === 'brush' || o.tool() === 'eraser' || o.tool() === 'group') && strokeInProgress) {
      // Commit (1-point click ok). kind='erase'=CanvasScreen delete-by-intersection;
      // 'group'=MergeCanvasScreen POST candidate-object (server resolves); 'stroke'=brush create.
      const pts = o.draft();  // keep sub-pixel float precision (t61) — the BE + polyline already store floats
      const kind = ({eraser: 'erase', group: 'group'} as const)[o.tool() as 'eraser' | 'group'] ?? 'stroke';
      o.commit(kind, pts, 1, o.brushSize());
      o.setDraft([]);
      strokeInProgress = false;
    }
    panDragging = false;
    spacePanRef = null;
    lastPanClient = null;
  };

  const handleKeyDown = (e: KeyboardEvent) => { if (e.key === ' ') setSpaceDown(true); };
  const handleKeyUp = (e: KeyboardEvent) => { if (e.key === ' ') { setSpaceDown(false); spacePanRef = null; } };

  const finishDraft = () => {
    const tl = o.tool();
    if (tl === 'polyline') return;  // Per-click rebuild: every click already persisted.
    const d = o.draft();
    if (tl === 'polygon' && d.length >= 3) o.commit('polygon', d, 2);
    else if (tl === 'line' && d.length >= 2) o.commit('line', d);
    o.setDraft([]);
  };
  return { toImage, onWheel, onPointerDown, onPointerMove, onPointerUp, onPointerLeave, handleKeyDown, handleKeyUp, isSpaceDown: spaceDown, hoverImg, finishDraft };
}
