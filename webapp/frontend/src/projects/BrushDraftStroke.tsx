import { type Component, createMemo, createUniqueId } from 'solid-js';
import { brushCenterlineSyncOrEmpty } from './geoEngine';
import { LIVE_DRAFT } from './LiveDraftOverlay';

/** t158 — the live brush/eraser draft, painted by the browser.
 *
 * The engine's brush outline is a round brush of diameter `size` dragged along its smoothed
 * centreline. So the preview asks the engine only for that centreline (cheap, no polygon union)
 * and paints it as a round-capped, round-joined stroke of the same width — the same shape the
 * server stores, without recomputing the full outline every pointer move (which made long
 * strokes progressively laggier).
 *
 * Look matches the old outline rendering: translucent fill, a dark edge straddling the boundary,
 * a white halo just outside it. The edge/halo widths are screen-px constants (`scale` = image px
 * per screen px); both are masked off the interior so the fill stays see-through. */
export const BrushDraftStroke: Component<{
  draft: number[][]; size: number; scale: number; eraser: boolean;
}> = (props) => {
  const maskId = `brush-draft-ring-${createUniqueId()}`;
  const line = createMemo(() => brushCenterlineSyncOrEmpty(props.draft, props.size));
  // A one-point line still needs a (zero-length) segment for the round cap to paint a dot.
  const d = createMemo(() => {
    const pts = line();
    if (!pts.length) return '';
    const seq = pts.length === 1 ? [pts[0], pts[0]] : pts;
    return `M ${seq[0][0]} ${seq[0][1]} ` + seq.slice(1).map(([x, y]) => `L ${x} ${y}`).join(' ');
  });
  const edge = () => LIVE_DRAFT.strokeWidth * props.scale;
  const halo = () => LIVE_DRAFT.haloWidth * props.scale;
  // Mask region = the draft's bounds padded by the widest layer (bounded, cheap to rasterize).
  const box = createMemo(() => {
    const pts = line().length ? line() : props.draft;
    const pad = props.size + halo();
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const x0 = Math.min(...xs) - pad, y0 = Math.min(...ys) - pad;
    return { x: x0, y: y0, w: Math.max(...xs) + pad - x0, h: Math.max(...ys) + pad - y0 };
  });
  const round = { 'stroke-linecap': 'round', 'stroke-linejoin': 'round', fill: 'none' } as const;
  return (
    <g pointer-events="none" data-testid="brush-draft">
      <mask id={maskId} maskUnits="userSpaceOnUse" x={box().x} y={box().y} width={box().w} height={box().h}>
        <rect x={box().x} y={box().y} width={box().w} height={box().h} fill="white" />
        <path d={d()} {...round} stroke="black" stroke-width={Math.max(props.size - edge(), 0)} />
      </mask>
      <path d={d()} {...round} data-testid="brush-draft-fill"
        stroke={props.eraser ? LIVE_DRAFT.eraserFill : LIVE_DRAFT.brushFill} stroke-width={props.size} />
      <path d={d()} {...round} mask={`url(#${maskId})`}
        stroke={LIVE_DRAFT.haloColor} stroke-width={props.size + halo()} />
      <path d={d()} {...round} mask={`url(#${maskId})`}
        stroke={props.eraser ? LIVE_DRAFT.eraserStroke : LIVE_DRAFT.brushStroke}
        stroke-width={props.size + edge()} />
    </g>
  );
};
