// Admin-only viewport-attention HEATMAP overlay + controls, rendered over the
// annotation image in the admin's read-only canvas view (CanvasScreen when isAdmin).
//
// This is the OVERLAY only — the animated "replay" viewport box is a separate later
// stage and is deliberately NOT built here.
//
// Math lives in viewportHeatmap.ts (pure, unit-testable). This module exposes a
// `createViewportHeatmap` hook (state + fetch + grid) plus two presentational pieces:
//  - ViewportHeatmapLayer:  the SVG <g> of colored cells (rendered INSIDE the canvas
//    <svg>, so it shares the image-space viewBox and pans/zooms with the image);
//  - ViewportHeatmapPanel:  the floating admin controls (show/hide + min/max sliders).
// Both read the same hook instance so toggling/sliders updates the layer live.
import { type Component, For, Show, createMemo, createResource, createSignal } from 'solid-js';
import type { Accessor } from 'solid-js';
import { canvasApi, type ViewportEventRow } from './canvasApi';
import { t } from '../i18n/catalog';
import {
  accumulateAttention, heatColor, makeGrid, normalizeGrid, type ViewportEvent,
} from './viewportHeatmap';
import * as styles from './ViewportHeatmap.css';

type Cell = { x: number; y: number; w: number; h: number; color: string };

export interface ViewportHeatmap {
  show: Accessor<boolean>;
  setShow: (v: boolean) => void;
  lo: Accessor<number>;
  setLo: (v: number) => void;
  hi: Accessor<number>;
  setHi: (v: number) => void;
  cells: Accessor<Cell[]>;
  count: Accessor<number>;
}

/** Owns the telemetry fetch + attention grid + admin controls state. Returns accessors
 *  for the two presentational pieces below. Swallows fetch errors (the heatmap is a
 *  bonus overlay — it must never block the admin's read-only canvas view).
 *
 *  `annotatorId` is the SELECTED / "viewing as" annotator (see annotatorSelect.ts), NOT
 *  the admin's own session — admin telemetry is never recorded (create_viewport_events
 *  skips admin server-side), so keying the read to the admin would always be empty. */
export function createViewportHeatmap(
  projectId: Accessor<string>,
  imageId: Accessor<string>,
  imageWidth: Accessor<number>,
  imageHeight: Accessor<number>,
  annotatorId: Accessor<string | undefined>,
): ViewportHeatmap {
  const [show, setShow] = createSignal(false);
  const [lo, setLo] = createSignal(0);
  const [hi, setHi] = createSignal(1);

  const [rows] = createResource(
    () => {
      const p = projectId(); const i = imageId(); const u = annotatorId();
      return (p && i && u) ? `${p}|${i}|${u}` : undefined;
    },
    async (key: string) => {
      const [p, i, u] = key.split('|');
      try {
        return (await canvasApi.listViewportEvents(p, i, u)).events;
      } catch {
        return [] as ViewportEventRow[];
      }
    },
  );

  const cells = createMemo<Cell[]>(() => {
    const evs = rows();
    const w = imageWidth(); const h = imageHeight();
    if (!evs || evs.length < 2 || w <= 0 || h <= 0) return [];
    const grid = makeGrid(w, h);
    const samples: ViewportEvent[] = evs.map((e) => ({
      userId: e.userId, clientTs: e.clientTs, x: e.x, y: e.y, w: e.w, h: e.h,
      cssW: e.cssW, cssH: e.cssH, dpr: e.dpr,
    }));
    accumulateAttention(grid, samples);
    normalizeGrid(grid);
    const curLo = lo(); const curHi = hi();
    const out: Cell[] = [];
    const { cols, rows: nrows, cellW, cellH, data } = grid;
    for (let j = 0; j < nrows; j++) {
      for (let i = 0; i < cols; i++) {
        const v = data[j * cols + i];
        if (v <= 0) continue;
        const [r, g, b, a] = heatColor(v, curLo, curHi);
        if (a <= 0) continue;
        out.push({
          x: i * cellW, y: j * cellH, w: cellW, h: cellH,
          color: `rgba(${r},${g},${b},${a.toFixed(3)})`,
        });
      }
    }
    return out;
  });

  return { show, setShow, lo, setLo, hi, setHi, cells, count: () => rows()?.length ?? 0 };
}

/** SVG layer: one translucent colored rect per non-empty grid cell. Render this INSIDE
 *  the canvas <svg> so it shares the image-space viewBox (pans/zooms with the image).
 *  pointer-events:none so it never blocks canvas interaction. */
export const ViewportHeatmapLayer: Component<{ heat: ViewportHeatmap }> = (props) => (
  <Show when={props.heat.show() && props.heat.cells().length > 0}>
    <g pointer-events="none" data-testid="viewport-heatmap">
      <For each={props.heat.cells()}>{(c) => (
        <rect x={c.x} y={c.y} width={c.w} height={c.h} fill={c.color} />
      )}</For>
    </g>
  </Show>
);

/** Floating admin controls: show/hide toggle + min/max color-range sliders. Render this
 *  OUTSIDE the <svg> (it's an HTML panel absolutely positioned over the stage). */
export const ViewportHeatmapPanel: Component<{ heat: ViewportHeatmap }> = (props) => (
  <div class={styles.panel} data-testid="viewport-heatmap-controls">
    <label class={styles.toggle}>
      <input class={styles.checkbox} type="checkbox" checked={props.heat.show()}
        onChange={(e) => props.heat.setShow(e.currentTarget.checked)} />
      {t('heatmap.toggle')}
    </label>
    <Show when={props.heat.count() > 0} fallback={
      <div class={styles.hint}>{t('heatmap.empty')}</div>
    }>
      <div class={styles.hint}>{t('heatmap.summary', { count: props.heat.count() })}</div>
      <div class={styles.ramp} title={t('heatmap.ramp')}
        style={{ background: 'linear-gradient(to right, rgb(68,1,84), rgb(59,82,139), rgb(33,144,141), rgb(94,201,98), rgb(253,231,37))' }} />
      <div class={styles.row}>
        <span class={styles.label}>{t('heatmap.min')}</span>
        <input class={styles.slider} type="range" min="0" max="1" step="0.01"
          value={props.heat.lo()}
          onInput={(e) => props.heat.setLo(parseFloat(e.currentTarget.value))} />
        <span class={styles.value}>{props.heat.lo().toFixed(2)}</span>
      </div>
      <div class={styles.row}>
        <span class={styles.label}>{t('heatmap.max')}</span>
        <input class={styles.slider} type="range" min="0" max="1" step="0.01"
          value={props.heat.hi()}
          onInput={(e) => props.heat.setHi(parseFloat(e.currentTarget.value))} />
        <span class={styles.value}>{props.heat.hi().toFixed(2)}</span>
      </div>
    </Show>
  </div>
);
