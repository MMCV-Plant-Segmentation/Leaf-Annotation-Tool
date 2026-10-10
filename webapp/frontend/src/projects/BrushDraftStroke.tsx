import { type Component, createMemo, createUniqueId, For, onCleanup } from 'solid-js';
import { createBrushStream } from './brushStream';
import { LIVE_DRAFT } from './LiveDraftOverlay';
import type { Ring } from './geoEngine';

/** t158 — the live brush/eraser draft, painted by the browser.
 *
 * The engine's brush outline is a round brush of diameter `size` dragged along its smoothed
 * centreline, so the preview paints that centreline as a round-capped, round-joined stroke of the
 * same width — the same shape the server stores. The centreline is built INCREMENTALLY
 * (brushStream.ts): only a short tail behind the pen can still change, and everything before it is
 * final. Final parts are painted as closed chunk paths that are never re-rendered; each pointer
 * move only redraws the open chunk + tail.
 *
 * Look matches the old outline rendering: translucent fill, a dark edge straddling the boundary,
 * a white halo just outside it. The edge/halo widths are screen-px constants (`scale` = image px
 * per screen px); both are masked off the interior so the fill stays see-through. The fill's
 * alpha is applied once to the whole group, so overlapping chunk ends don't darken. */
export const BrushDraftStroke: Component<{
  draft: number[][]; size: number; scale: number; eraser: boolean;
}> = (props) => {
  const maskId = `brush-draft-ring-${createUniqueId()}`;
  const stream = createBrushStream();
  onCleanup(stream.end);
  const line = createMemo(() => stream.update(props.draft, props.size));
  const live = createMemo(() => pathD(line().live));
  const edge = () => LIVE_DRAFT.strokeWidth * props.scale;
  const halo = () => LIVE_DRAFT.haloWidth * props.scale;
  // Mask region = the line's bounds padded by the widest layer (bounded, cheap to rasterize).
  const box = createMemo(() => {
    const b = line().box, pad = props.size + halo();
    if (!b) return { x: 0, y: 0, w: 0, h: 0 };
    return { x: b.x0 - pad, y: b.y0 - pad, w: b.x1 - b.x0 + 2 * pad, h: b.y1 - b.y0 + 2 * pad };
  });
  const fill = createMemo(() => solid(props.eraser ? LIVE_DRAFT.eraserFill : LIVE_DRAFT.brushFill));
  // One layer of the stroke: every closed chunk (painted once) plus the live path.
  const Layer = (p: { stroke: string; width: number; mask?: string; testid?: string }) => (
    <>
      <For each={line().chunks}>{(c) => {
        const d = pathD(c);
        return <path d={d} {...ROUND} stroke={p.stroke} stroke-width={p.width} mask={p.mask} />;
      }}</For>
      <path d={live()} {...ROUND} stroke={p.stroke} stroke-width={p.width} mask={p.mask}
        data-testid={p.testid} />
    </>
  );
  return (
    <g pointer-events="none" data-testid="brush-draft">
      <mask id={maskId} maskUnits="userSpaceOnUse" x={box().x} y={box().y} width={box().w} height={box().h}>
        <rect x={box().x} y={box().y} width={box().w} height={box().h} fill="white" />
        <Layer stroke="black" width={Math.max(props.size - edge(), 0)} />
      </mask>
      <g opacity={fill().opacity}>
        <Layer stroke={fill().color} width={props.size} testid="brush-draft-fill" />
      </g>
      <Layer stroke={LIVE_DRAFT.haloColor} width={props.size + halo()} mask={`url(#${maskId})`} />
      <Layer stroke={props.eraser ? LIVE_DRAFT.eraserStroke : LIVE_DRAFT.brushStroke}
        width={props.size + edge()} mask={`url(#${maskId})`} />
    </g>
  );
};

const ROUND = { 'stroke-linecap': 'round', 'stroke-linejoin': 'round', fill: 'none' } as const;

/** SVG path through `pts`. A one-point line still needs a (zero-length) segment for the round cap
 * to paint a dot. */
function pathD(pts: Ring): string {
  if (!pts.length) return '';
  const seq = pts.length === 1 ? [pts[0], pts[0]] : pts;
  return `M ${seq[0][0]} ${seq[0][1]} ` + seq.slice(1).map(([x, y]) => `L ${x} ${y}`).join(' ');
}

/** Split `rgba(r,g,b,a)` into an opaque colour + its alpha (any other colour: alpha 1). */
function solid(c: string): { color: string; opacity: number } {
  const m = /^rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/.exec(c);
  return m ? { color: `rgb(${m[1]},${m[2]},${m[3]})`, opacity: Number(m[4]) } : { color: c, opacity: 1 };
}
