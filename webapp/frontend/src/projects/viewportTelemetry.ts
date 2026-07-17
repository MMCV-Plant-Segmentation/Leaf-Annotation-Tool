// Best-effort viewport (pan/zoom) telemetry — split out of CanvasScreen (≤200-line
// limit). Buffers samples of the canvas's SVG viewBox and ships them over the SHARED
// canvas WebSocket as fire-and-forget `{type:"viewport"}` frames (no ack, no FIFO slot).
// The server persists via do_create_viewport_events so we can later analyze how users
// view images at different magnifications (per-user "vision level" tile sizing — a
// later, separate feature; no UI here, this is telemetry-only). NEVER disrupts the
// annotation UX: every failure is swallowed silently — no thrown error, no console spam.
//
// Phase 3 (feat/annotation-ws): routed OVER THE SOCKET, not the REST endpoint. The
// prior page-hide sendBeacon fallback is DELETED — telemetry is best-effort and losing
// a last unflushed sample on unload is fine (no annotation happens on the pan/zoom that
// triggered the sample; real unsaved annotation data has its own beforeunload guard in
// CanvasScreen driven by socket.hasPending()). The REST endpoint (canvasApi.postViewportEvents)
// stays for external callers / server-side test, but the FE no longer calls it.
//
// No consent/opt-out gating — annotators are lab staff. This is the spot to add a gate
// (e.g. a per-user opt-out flag) if that's ever needed.
//
// Sampling: a debounced sample ~400ms after `vb()` stops changing (the settled pan/zoom,
// not every intermediate frame), PLUS a 2s heartbeat while an image is open (even if the
// viewport hasn't moved) so dwell time is measurable.
// Flushing: every 5s, and on image change.
import { createEffect, on, onCleanup, onMount } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { ViewportSample } from './canvasApi';
import type { ViewBox } from './canvasShapes';
import type { CanvasSocket } from './canvasSocket';

export interface ViewportTelemetryOpts {
  getProjectId: () => string | undefined;
  imageId: Accessor<string | undefined>;
  vb: Accessor<ViewBox>;
  /** The SVG canvas element, for its CSS pixel size (clientWidth/Height) at capture time. */
  getSvg: () => SVGSVGElement | undefined;
  /** True while the session is admin — admins are read-only, so their navigation is
   *  never sampled or sent (the backend also guards this in the WS handler + do_*
   *  function, but skipping client-side avoids buffering work that would be a no-op). */
  isAdmin: Accessor<boolean>;
  /** Phase 3 (feat/annotation-ws): the shared canvas socket. `socket.post()` fires
   *  frames without an ack (viewport samples are best-effort telemetry — they must
   *  NEVER head-of-line-block real annotation ops on the same channel). */
  socket: CanvasSocket;
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
      if (o.isAdmin() || !curImageId) return;
      const s = capture();
      if (s) buffer.push(s);
    } catch { /* fail-quiet: telemetry must never disrupt annotation UX */ }
  };

  const flush = () => {
    try {
      if (o.isAdmin()) { buffer = []; return; }
      if (buffer.length === 0 || !curProjectId || !curImageId) { buffer = []; return; }
      const events = buffer;
      buffer = [];
      // Fire-and-forget over the socket: no ack, no FIFO slot — telemetry must NEVER
      // block a real annotation op (canvasSocket.ts post() docs). The socket is shared
      // with all mutations, so we simply piggy-back on its live connection.
      o.socket.post('viewport', { projectId: curProjectId, imageId: curImageId, events });
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
    const flushTimer = setInterval(flush, FLUSH_MS);

    onCleanup(() => {
      clearInterval(heartbeat);
      clearInterval(flushTimer);
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      flush();
    });
  });
}
