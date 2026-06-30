import { createSignal } from 'solid-js';
import type { Accessor, Setter } from 'solid-js';
import type { Tool, ViewBox } from './canvasShapes';

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
  commit: (kind: string, points: number[][], passNo?: number, strokeWidth?: number) => void;
}

export interface CanvasInteraction {
  toImage: (clientX: number, clientY: number) => [number, number];
  onWheel: (e: WheelEvent) => void;
  onPointerDown: (e: PointerEvent) => void;
  onPointerMove: (e: PointerEvent) => void;
  onPointerUp: (e: PointerEvent) => void;
  handleKeyDown: (e: KeyboardEvent) => void;
  handleKeyUp: (e: KeyboardEvent) => void;
  isSpaceDown: Accessor<boolean>;
  finishDraft: () => void;
}

// Pointer/zoom/draft controller for the annotation canvas. Pure closure over the
// supplied signals — keeps CanvasScreen focused on data + composition.
export function createCanvasInteraction(o: CanvasInteractionOpts): CanvasInteraction {
  // Space-bar pan state (reactive so SVG cursor can respond)
  const [spaceDown, setSpaceDown] = createSignal(false);
  let spacePanRef: { x: number; y: number; vb: ViewBox } | null = null;

  // Mid-stroke pan lock (B §D: all pan disabled while pointer is down drawing)
  let strokeInProgress = false;
  let panDragging = false;
  let lastPanClient: { x: number; y: number } | null = null;

  // Multi-touch tracking for two-finger pinch (§E)
  type TouchPt = { clientX: number; clientY: number; imgX: number; imgY: number };
  const touches = new Map<number, TouchPt>();
  let pinchStart: { dist: number; midImgX: number; midImgY: number; vb: ViewBox } | null = null;

  // pointer client px → image-pixel coords (float for smooth draft)
  const toImage = (clientX: number, clientY: number): [number, number] => {
    const rect = o.getSvg()!.getBoundingClientRect();
    const v = o.vb();
    return [v.x + ((clientX - rect.left) / rect.width) * v.w,
            v.y + ((clientY - rect.top) / rect.height) * v.h];
  };

  const clampSize = (s: number) => Math.max(1, Math.min(o.maxBrushSize(), Math.round(s)));

  // Step brush size by 5% of max (at least 1px) — used by [ / ] keys and scroll
  const stepSize = (dir: 1 | -1) => {
    o.setBrushSize(clampSize(o.brushSize() + dir * Math.max(1, Math.round(o.maxBrushSize() * 0.05))));
  };

  const panBy = (dClientX: number, dClientY: number) => {
    const rect = o.getSvg()!.getBoundingClientRect();
    const v = o.vb();
    o.setVb({ ...v, x: v.x - (dClientX / rect.width) * v.w, y: v.y - (dClientY / rect.height) * v.h });
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
    if (o.tool() === 'brush' && !e.shiftKey) {
      // Brush mode plain scroll → adjust size (§B)
      stepSize(e.deltaY > 0 ? -1 : 1);
      return;
    }
    // Shift+scroll → pan horizontal; else pan vertical (§C)
    if (e.shiftKey) { panBy(e.deltaY, 0); } else { panBy(0, e.deltaY); }
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
    if (tl === 'pan') { panDragging = true; lastPanClient = { x: e.clientX, y: e.clientY }; return; }
    if (tl === 'brush') { strokeInProgress = true; o.setDraft([[ix, iy]]); return; }
    // polygon/line: add a vertex (legacy tools, not shown in toolbar)
    o.setDraft((d) => [...d, [Math.round(ix), Math.round(iy)]]);
  };

  const onPointerMove = (e: PointerEvent) => {
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
      const midFracX = ((pts[0].clientX + pts[1].clientX) / 2 - rect.left) / rect.width;
      const midFracY = ((pts[0].clientY + pts[1].clientY) / 2 - rect.top) / rect.height;
      o.setVb({ x: pinchStart.midImgX - midFracX * nw, y: pinchStart.midImgY - midFracY * nh, w: nw, h: nh });
      return;
    }

    // Space-pan (§C, §D)
    if (spacePanRef && !strokeInProgress) {
      const sv = spacePanRef.vb;
      const rect = o.getSvg()!.getBoundingClientRect();
      o.setVb({ ...sv, x: sv.x - ((e.clientX - spacePanRef.x) / rect.width) * sv.w,
                        y: sv.y - ((e.clientY - spacePanRef.y) / rect.height) * sv.h });
      return;
    }

    if (o.tool() === 'pan' && panDragging && lastPanClient) {
      panBy(e.clientX - lastPanClient.x, e.clientY - lastPanClient.y);
      lastPanClient = { x: e.clientX, y: e.clientY };
      return;
    }
    if (o.tool() === 'brush' && strokeInProgress) {
      const [ix, iy] = toImage(e.clientX, e.clientY);
      o.setDraft((d) => [...d, [ix, iy]]);
    }
  };

  const onPointerUp = (e: PointerEvent) => {
    touches.delete(e.pointerId);
    if (touches.size < 2) pinchStart = null;

    if (o.tool() === 'brush' && strokeInProgress) {
      // Commit; single-click (1 point) still works — buildStrokePath renders it as a circle
      const pts = o.draft().map(([x, y]) => [Math.round(x), Math.round(y)]);
      o.commit('stroke', pts, 1, o.brushSize());
      o.setDraft([]);
      strokeInProgress = false;
    }
    panDragging = false;
    spacePanRef = null;
    lastPanClient = null;
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === ' ') setSpaceDown(true);
    if (e.key === '[') { e.preventDefault(); stepSize(-1); }
    if (e.key === ']') { e.preventDefault(); stepSize(1); }
  };

  const handleKeyUp = (e: KeyboardEvent) => {
    if (e.key === ' ') { setSpaceDown(false); spacePanRef = null; }
  };

  const finishDraft = () => {
    const d = o.draft(); const tl = o.tool();
    if (tl === 'polygon' && d.length >= 3) o.commit('polygon', d, 2);
    else if (tl === 'line' && d.length >= 2) o.commit('line', d);
    o.setDraft([]);
  };

  return { toImage, onWheel, onPointerDown, onPointerMove, onPointerUp, handleKeyDown, handleKeyUp, isSpaceDown: spaceDown, finishDraft };
}
