// Best-effort viewport (pan/zoom) telemetry — split out of CanvasScreen (≤200-line
// limit). Buffers samples of the canvas's SVG viewBox and batch-POSTs them to
// POST /api/projects/<id>/viewport-events, so we can later analyze how users view
// images at different magnifications (per-user "vision level" tile sizing — a later,
// separate feature; no UI here, this is telemetry-only). NEVER disrupts annotation UX:
// every failure is swallowed silently — no thrown error, no console spam.
//
// No consent/opt-out gating — annotators are lab staff. This is the spot to add a gate
// (e.g. a per-user opt-out flag) if that's ever needed.
//
// Sampling: a debounced sample ~400ms after `vb()` stops changing (the settled pan/zoom,
// not every intermediate frame), PLUS a 2s heartbeat while an image is open (even if the
// viewport hasn't moved) so dwell time is measurable.
// Flushing: every 5s, on image change, and on page hide/unload (via sendBeacon, since a
// regular fetch can be cancelled mid-flight by the page going away).
import { createEffect, on, onCleanup, onMount } from 'solid-js';
import type { Accessor } from 'solid-js';
import { canvasApi } from './canvasApi';
import type { ViewportSample } from './canvasApi';
import type { ViewBox } from './canvasShapes';

export interface ViewportTelemetryOpts {
  getProjectId: () => string | undefined;
  imageId: Accessor<string | undefined>;
  vb: Accessor<ViewBox>;
  /** The SVG canvas element, for its CSS pixel size (clientWidth/Height) at capture time. */
  getSvg: () => SVGSVGElement | undefined;
}

const SETTLE_MS = 400;
const HEARTBEAT_MS = 2000;
const FLUSH_MS = 5000;

export function createViewportTelemetry(o: ViewportTelemetryOpts): void {
  let buffer: ViewportSample[] = [];
  let curProjectId: string | undefined;
  let curImageId: string | undefined;

  const capture = (): ViewportSample | null => {
    const svg = o.getSvg();
    if (!svg) return null;
    const { x, y, w, h } = o.vb();
    return {
      clientTs: new Date().toISOString(), x, y, w, h,
      cssW: svg.clientWidth, cssH: svg.clientHeight,
      dpr: window.devicePixelRatio || 1,
    };
  };

  const sample = () => {
    try {
      if (!curImageId) return;
      const s = capture();
      if (s) buffer.push(s);
    } catch { /* fail-quiet: telemetry must never disrupt annotation UX */ }
  };

  const flush = (useBeacon = false) => {
    try {
      if (buffer.length === 0 || !curProjectId || !curImageId) { buffer = []; return; }
      const body = { imageId: curImageId, events: buffer };
      buffer = [];
      if (useBeacon) {
        navigator.sendBeacon?.(
          `/api/projects/${curProjectId}/viewport-events`,
          new Blob([JSON.stringify(body)], { type: 'application/json' }),
        );
        return;
      }
      void canvasApi.postViewportEvents(curProjectId, body).catch(() => { /* fail-quiet */ });
    } catch { /* fail-quiet */ }
  };

  // Settle-debounce: sample ~400ms after vb() stops changing.
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(on(o.vb, () => {
    if (!curImageId) return;
    if (settleTimer !== undefined) clearTimeout(settleTimer);
    settleTimer = setTimeout(sample, SETTLE_MS);
  }));

  // Image change: flush whatever's buffered for the OLD image before switching bookkeeping.
  createEffect(on(o.imageId, (id) => {
    flush();
    curProjectId = o.getProjectId();
    curImageId = id;
  }));

  onMount(() => {
    const heartbeat = setInterval(sample, HEARTBEAT_MS);
    const flushTimer = setInterval(() => flush(), FLUSH_MS);
    const onHide = () => { if (document.visibilityState === 'hidden') flush(true); };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);

    onCleanup(() => {
      clearInterval(heartbeat);
      clearInterval(flushTimer);
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
      flush(true);
    });
  });
}
