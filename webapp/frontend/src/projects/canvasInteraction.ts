import type { Accessor, Setter } from 'solid-js';
import type { Tool, ViewBox } from './canvasShapes';

export interface CanvasInteractionOpts {
  getSvg: () => SVGSVGElement | undefined;
  vb: Accessor<ViewBox>;
  setVb: Setter<ViewBox>;
  tool: Accessor<Tool>;
  draft: Accessor<number[][]>;
  setDraft: Setter<number[][]>;
  commit: (kind: string, points: number[][], passNo?: number) => void;
}

export interface CanvasInteraction {
  toImage: (clientX: number, clientY: number) => [number, number];
  onWheel: (e: WheelEvent) => void;
  onPointerDown: (e: PointerEvent) => void;
  onPointerMove: (e: PointerEvent) => void;
  onPointerUp: () => void;
  finishDraft: () => void;
}

// Pointer/zoom/draft controller for the annotation canvas. Pure closure over the
// supplied signals — keeps CanvasScreen focused on data + composition.
export function createCanvasInteraction(o: CanvasInteractionOpts): CanvasInteraction {
  let dragging = false;
  let lastClient: { x: number; y: number } | null = null;

  // pointer client px → image-pixel coords
  const toImage = (clientX: number, clientY: number): [number, number] => {
    const rect = o.getSvg()!.getBoundingClientRect();
    const v = o.vb();
    const x = v.x + ((clientX - rect.left) / rect.width) * v.w;
    const y = v.y + ((clientY - rect.top) / rect.height) * v.h;
    return [Math.round(x), Math.round(y)];
  };

  // zoom around the cursor
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const [ix, iy] = toImage(e.clientX, e.clientY);
    const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    o.setVb((v) => {
      const nw = v.w * factor, nh = v.h * factor;
      return { x: ix - (ix - v.x) * (nw / v.w), y: iy - (iy - v.y) * (nh / v.h), w: nw, h: nh };
    });
  };

  const onPointerDown = (e: PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    lastClient = { x: e.clientX, y: e.clientY };
    const tl = o.tool();
    if (tl === 'pan') { dragging = true; return; }
    const [ix, iy] = toImage(e.clientX, e.clientY);
    if (tl === 'point') { o.commit('point', [[ix, iy]]); return; }
    if (tl === 'brush') { dragging = true; o.setDraft([[ix, iy]]); return; }
    // polygon / line: add a vertex
    o.setDraft((d) => [...d, [ix, iy]]);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!dragging || !lastClient) return;
    const tl = o.tool();
    if (tl === 'pan') {
      const rect = o.getSvg()!.getBoundingClientRect();
      const v = o.vb();
      const dx = ((e.clientX - lastClient.x) / rect.width) * v.w;
      const dy = ((e.clientY - lastClient.y) / rect.height) * v.h;
      o.setVb({ ...v, x: v.x - dx, y: v.y - dy });
      lastClient = { x: e.clientX, y: e.clientY };
    } else if (tl === 'brush') {
      const [ix, iy] = toImage(e.clientX, e.clientY);
      o.setDraft((d) => [...d, [ix, iy]]);
    }
  };

  const onPointerUp = () => {
    const tl = o.tool();
    if (tl === 'brush' && o.draft().length >= 3) { o.commit('stroke', o.draft(), 1); }
    if (tl === 'brush') o.setDraft([]);
    dragging = false;
    lastClient = null;
  };

  const finishDraft = () => {
    const d = o.draft();
    const tl = o.tool();
    if (tl === 'polygon' && d.length >= 3) o.commit('polygon', d, 2);
    else if (tl === 'line' && d.length >= 2) o.commit('line', d);
    o.setDraft([]);
  };

  return { toImage, onWheel, onPointerDown, onPointerMove, onPointerUp, finishDraft };
}
