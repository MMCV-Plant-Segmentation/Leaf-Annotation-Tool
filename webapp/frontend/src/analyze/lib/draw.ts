import type { AnalyzeData, Mode, Ring, VisiblePileResult } from './types';
import { computeVisiblePiles } from './agreement';
import { hexToRgba } from './geometry';
import { deltaAlpha, effectiveKAgree } from './agreement';

export interface DrawOpts {
  kMin: number;
  kAgree: number;
  iouFilter: number;
  mode: Mode;
  annotColor: string;
  annotOpacity: number;
  showBbox: boolean;
  blind: boolean;
  selectedPileId: string | null;
  sourceColorMap: Record<string, string>;
  sourceNameMap: Record<string, string>;
}

export interface AView { zoom: number; viewX: number; viewY: number; }

export function resizeCanvas(cv: HTMLCanvasElement): void {
  const dpr = window.devicePixelRatio || 1;
  cv.width  = Math.round((cv.clientWidth  || cv.offsetWidth)  * dpr);
  cv.height = Math.round((cv.clientHeight || cv.offsetHeight) * dpr);
}

export function frameUnion(data: AnalyzeData, cv: HTMLCanvasElement, aView: AView): void {
  if (!data.piles.length) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const pile of data.piles) {
    const [bx0, by0, bx1, by1] = pile.bbox;
    x0 = Math.min(x0, bx0); y0 = Math.min(y0, by0);
    x1 = Math.max(x1, bx1); y1 = Math.max(y1, by1);
  }
  if (!isFinite(x0)) return;
  const bw = x1 - x0, bh = y1 - y0;
  const px0 = Math.max(0, x0 - bw * 0.1);
  const py0 = Math.max(0, y0 - bh * 0.1);
  const pw  = Math.min(data.imageWidth,  x1 + bw * 0.1) - px0;
  const ph  = Math.min(data.imageHeight, y1 + bh * 0.1) - py0;
  if (!cv.width || !pw || !ph) return;
  aView.zoom  = Math.min(cv.width / pw, cv.height / ph) * 0.9;
  aView.viewX = (px0 + pw / 2) - cv.width  / 2 / aView.zoom;
  aView.viewY = (py0 + ph / 2) - cv.height / 2 / aView.zoom;
}

export function drawAnalyzeCanvas(
  cv: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  data: AnalyzeData,
  aView: AView,
  img: HTMLImageElement | null,
  opts: DrawOpts,
): VisiblePileResult[] {
  const { kMin, kAgree, iouFilter, mode, annotColor, annotOpacity,
          showBbox, blind, selectedPileId, sourceColorMap, sourceNameMap } = opts;
  const dpr = window.devicePixelRatio || 1;

  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = '#0d0f13';
  ctx.fillRect(0, 0, cv.width, cv.height);

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (img?.complete && img.naturalWidth) {
    ctx.drawImage(img,
      -aView.viewX * aView.zoom, -aView.viewY * aView.zoom,
      data.imageWidth * aView.zoom, data.imageHeight * aView.zoom,
    );
  }

  const { visible } = computeVisiblePiles(data, { kMin, kAgree, iouFilter, mode });

  const wx = (x: number) => (x - aView.viewX) * aView.zoom;
  const wy = (y: number) => (y - aView.viewY) * aView.zoom;

  function traceRing(ring: Ring) {
    if (ring.length < 2) return false;
    ctx.beginPath();
    ctx.moveTo(wx(ring[0][0]), wy(ring[0][1]));
    for (let i = 1; i < ring.length; i++) ctx.lineTo(wx(ring[i][0]), wy(ring[i][1]));
    ctx.closePath();
    return true;
  }

  function strokeRings(rings: Ring[], fn: () => void) {
    for (const ring of rings) { if (traceRing(ring)) fn(); }
  }

  for (const { pile, fraction } of visible) {
    const selected = pile.id === selectedPileId;
    const N = mode === 'absolute' ? data.mTotal : pile.m;

    // Delta-alpha ring stacking
    for (let ki = 1; ki <= pile.m; ki++) {
      const entry = pile.agreementByK[String(ki)];
      if (!entry) continue;
      const da = deltaAlpha(annotOpacity, N, ki);
      ctx.fillStyle = hexToRgba(annotColor, Math.min(1, selected ? Math.min(1, da * 1.4) : da));
      for (const ring of entry.rings) { if (traceRing(ring)) ctx.fill(); }
    }

    // Bounding box
    if (showBbox) {
      const [bx0, by0, bx1, by1] = pile.bbox;
      ctx.save();
      ctx.strokeStyle = selected ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.45)';
      ctx.lineWidth   = (selected ? 1.5 : 1) * dpr;
      ctx.setLineDash([4 * dpr, 4 * dpr]);
      ctx.strokeRect(wx(bx0), wy(by0), (bx1 - bx0) * aView.zoom, (by1 - by0) * aView.zoom);
      ctx.restore();
    }

    // IoU label
    const label = Math.round(fraction * 100) + '%';
    const lx = wx((pile.bbox[0] + pile.bbox[2]) / 2);
    const ly = wy((pile.bbox[1] + pile.bbox[3]) / 2);
    ctx.save();
    ctx.font = `bold ${11 * dpr}px system-ui`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth   = 3 * dpr;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.strokeText(label, lx, ly);
    ctx.fillStyle = selected ? '#ffd43b' : 'rgba(255,255,255,0.9)';
    ctx.fillText(label, lx, ly);
    ctx.restore();

    if (selected) {
      // Per-source outlines
      for (const src of pile.sourceRings) {
        const color = blind ? 'rgba(255,255,255,0.85)' : (sourceColorMap[src.sourceId] || '#ffffff');
        ctx.save();
        ctx.strokeStyle = color; ctx.lineWidth = 2 * dpr; ctx.setLineDash([]);
        strokeRings(src.rings, () => ctx.stroke());
        ctx.restore();
      }
      // Union outline
      const uEntry = pile.agreementByK['1'];
      if (uEntry) {
        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.lineWidth   = 1.5 * dpr;
        ctx.setLineDash([3 * dpr, 4 * dpr]);
        strokeRings(uEntry.rings, () => ctx.stroke());
        ctx.restore();
      }
      // Intersection highlight
      const overlayK = kAgree > 0 ? effectiveKAgree(kAgree, pile.m, mode) : 0;
      const iEntry   = overlayK > 0 ? pile.agreementByK[String(overlayK)] : null;
      if (iEntry) {
        ctx.save();
        ctx.fillStyle   = 'rgba(255,212,59,0.35)';
        ctx.strokeStyle = 'rgba(255,212,59,0.9)';
        ctx.lineWidth   = 2 * dpr; ctx.setLineDash([]);
        strokeRings(iEntry.rings, () => { ctx.fill(); ctx.stroke(); });
        ctx.restore();
      }
    }
  }

  // Source legend (top-left when pile selected + not blind)
  if (selectedPileId !== null && !blind) {
    const sel = visible.find(r => r.pile.id === selectedPileId)?.pile;
    if (sel) {
      const pad = 10 * dpr, rowH = 22 * dpr, circR = 5 * dpr;
      const bx = 12 * dpr, by = 12 * dpr;
      const boxW = 180 * dpr, boxH = pad * 2 + rowH * sel.sourceRings.length;
      ctx.save();
      ctx.fillStyle = 'rgba(13,15,19,0.78)';
      ctx.fillRect(bx, by, boxW, boxH);
      sel.sourceRings.forEach((src, i) => {
        const color = sourceColorMap[src.sourceId] || '#ffffff';
        const ry = by + pad + rowH * i + rowH / 2;
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(bx + pad + circR, ry, circR, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle   = 'rgba(255,255,255,0.9)';
        ctx.font        = `${11 * dpr}px system-ui`;
        ctx.textAlign   = 'left'; ctx.textBaseline = 'middle';
        const raw  = sourceNameMap[src.sourceId] || `Source ${i + 1}`;
        const name = raw.length > 20 ? raw.slice(0, 18) + '…' : raw;
        ctx.fillText(name, bx + pad + circR * 2 + 6 * dpr, ry);
      });
      ctx.restore();
    }
  }

  return visible;
}
