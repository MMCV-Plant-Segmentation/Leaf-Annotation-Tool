import { createRoot, createEffect, batch, onCleanup } from 'solid-js'; // batch used in click handler
import type { AnalyzeData, VisiblePileResult } from './lib/types';
import { drawAnalyzeCanvas, resizeCanvas, frameUnion, type AView } from './lib/draw';
import { ptInRing } from './lib/geometry';
import { getAvailablePairs } from './lib/bridge';
import * as store from './store';

const SRC_COLORS = ['#ff6b6b', '#51cf66', '#ffd43b', '#74c0fc', '#f783ac', '#a9e34b'];

const w = window as any;

export function mountAnalyzeViewer(data: AnalyzeData): () => void {
  const sourceIds = [...new Set(data.piles.flatMap(p => p.sourceRings.map(s => s.sourceId)))].sort();
  const sourceColorMap = Object.fromEntries(
    sourceIds.map((sid, i) => [sid, SRC_COLORS[i % SRC_COLORS.length]]),
  );
  const sourceNameMap = Object.fromEntries(
    sourceIds.map(sid => {
      const known = getAvailablePairs().find(p => p.id === sid);
      return [sid, known?.display_name ?? sid];
    }),
  );

  // Clone canvas to strip analyze.js's event listeners (they close over its internal aView)
  const oldCv = document.getElementById('analyze-canvas') as HTMLCanvasElement;
  const cv     = oldCv.cloneNode(false) as HTMLCanvasElement;
  oldCv.parentNode!.replaceChild(cv, oldCv);
  const ctx = cv.getContext('2d')!;
  cv.style.cursor = 'grab';

  return createRoot(dispose => {
    // Mutable pan/zoom state — mutated directly, bumps revision to trigger redraw
    const aView: AView = { zoom: 1, viewX: 0, viewY: 0 };

    // Visible piles after last draw — used by click hit-test
    let lastVisible: VisiblePileResult[] = [];

    // Load image into store
    const image = new Image();
    image.src = `/api/image/${data.imageHash}`;
    image.onload = () => store.setImg(image);

    // Set globals that analyze.js canvas/header functions still read
    w.analyzeData           = data;
    w.analyzeSourceColorMap = sourceColorMap;
    w.analyzeSourceNameMap  = sourceNameMap;

    // Header + sidebar are Solid-owned; only need to bump revision for any residual calls.
    const origDraw = w._drawAnalyzeCanvas;
    w._drawAnalyzeCanvas = () => store.bump(r => r + 1);

    onCleanup(() => {
      w._drawAnalyzeCanvas = origDraw;
      cv.parentNode?.replaceChild(oldCv, cv);
      store.setImg(null);
    });

    // Reactive draw — subscribes to all signals that affect the canvas
    createEffect(() => {
      store.revision();
      const result = drawAnalyzeCanvas(cv, ctx, data, aView, store.img(), {
        kMin:          store.kMin(),
        kAgree:        store.kAgree(),
        iouFilter:     store.iouFilter(),
        mode:          store.mode(),
        annotColor:    store.annotColor(),
        annotOpacity:  store.annotOpacity(),
        showBbox:      store.showBbox(),
        blind:         store.blind(),
        selectedPileId: store.selectedId(),
        sourceColorMap,
        sourceNameMap,
      });
      lastVisible = result;
      w.analyzeVisiblePiles = result.map(r => r.pile);
    });

    // ── Pan / zoom / click ────────────────────────────────────────────────────

    let dragging = false, dragMoved = false, lastX = 0, lastY = 0;

    cv.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      dragging = true; dragMoved = false; lastX = e.clientX; lastY = e.clientY;
      cv.style.cursor = 'grabbing';
    });

    const onMove = (e: MouseEvent) => {
      if (!dragging) return;
      const dpr = window.devicePixelRatio || 1;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragMoved = true;
      aView.viewX -= dx * dpr / aView.zoom;
      aView.viewY -= dy * dpr / aView.zoom;
      lastX = e.clientX; lastY = e.clientY;
      store.bump(r => r + 1);
    };
    const onUp = (e: MouseEvent) => {
      if (!dragging || e.button !== 0) return;
      dragging = false; cv.style.cursor = 'grab';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
    onCleanup(() => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
    });

    cv.addEventListener('click', e => {
      if (dragMoved) return;
      const r   = cv.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const wx  = aView.viewX + (e.clientX - r.left) * dpr / aView.zoom;
      const wy  = aView.viewY + (e.clientY - r.top)  * dpr / aView.zoom;
      const hits = lastVisible
        .filter(({ pile }) => pile.sourceRings.some(src => src.rings.some(ring => ptInRing(wx, wy, ring))))
        .sort((a, b) => a.pile.id < b.pile.id ? -1 : 1);
      const hitId = hits.length ? hits[0].pile.id : null;
      const newId = hitId === store.selectedId() ? null : hitId;
      batch(() => {
        store.setSelectedId(newId);
        store.setDetailK(null);
      });
      w.analyzeSelectedPile = newId;
      w.analyzeDetailK      = null;
      store.bump(r => r + 1);
    });

    cv.addEventListener('wheel', e => {
      e.preventDefault();
      const r  = cv.getBoundingClientRect();
      const sx = (e.clientX - r.left) * (cv.width  / r.width);
      const sy = (e.clientY - r.top)  * (cv.height / r.height);
      const wx = aView.viewX + sx / aView.zoom;
      const wy = aView.viewY + sy / aView.zoom;
      const f  = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      aView.zoom  *= f;
      aView.viewX  = wx - sx / aView.zoom;
      aView.viewY  = wy - sy / aView.zoom;
      store.bump(r => r + 1);
    }, { passive: false });

    const ro = new ResizeObserver(() => {
      resizeCanvas(cv);
      store.bump(r => r + 1);
    });
    ro.observe(cv);
    onCleanup(() => ro.disconnect());

    requestAnimationFrame(() => {
      resizeCanvas(cv);
      frameUnion(data, cv, aView);
      w._drawAnalyzeCanvas(); // sync header controls → signals for initial draw
    });

    return dispose;
  });
}
