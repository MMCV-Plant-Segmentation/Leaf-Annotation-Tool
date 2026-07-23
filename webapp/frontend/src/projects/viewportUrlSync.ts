// t92 — persist + share the annotator canvas viewport (pan/zoom) via a URL query param, so
// a reload restores the exact view and the link is shareable. Split out of CanvasScreen (the
// ≤200-line limit) — modeled on viewportTelemetry.ts's debounced-on-`vb`-settle idiom.
//
// Restore: on the FIRST image load only (keyed on imageId, like telemetry's bookkeeping), if
// the URL query has a valid encoded viewport, setVb(decoded). Registering this effect AFTER
// CanvasScreen's own `on(imageId, fitImage)` effect means — within the same reactive flush —
// fitImage's "fit to image" default runs first and our restore (when present) applies on top
// of it, overriding the default. When there's no valid param we do nothing, so a parallel
// "frame the first tile by default" change is untouched.
//
// Write: a debounced sample ~400ms after `vb()` stops changing (the settled pan/zoom), written
// via history.replaceState (never pushState — no history spam), preserving any other existing
// query params.
import { createEffect, on } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { ViewBox } from './canvasShapes';
import { decodeViewport, encodeViewport } from './viewportUrl';

export interface ViewportUrlSyncOpts {
  imageId: Accessor<string | undefined>;
  vb: Accessor<ViewBox>;
  setVb: (vb: ViewBox) => void;
}

const SETTLE_MS = 400;
const PARAM = 'v';

export function createViewportUrlSync(o: ViewportUrlSyncOpts): void {
  let restored = false;

  // Restore once, after the image's own "fit to image" default has applied.
  createEffect(on(o.imageId, (id) => {
    if (restored || !id) return;
    restored = true;
    try {
      const raw = new URLSearchParams(window.location.search).get(PARAM);
      if (raw == null) return;
      const decoded = decodeViewport(raw);
      if (decoded) o.setVb(decoded);
    } catch { /* fail-quiet: URL restore must never disrupt the annotation UX */ }
  }));

  // Settle-debounce: write ~400ms after vb() stops changing.
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(on(o.vb, () => {
    if (settleTimer !== undefined) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      try {
        const url = new URL(window.location.href);
        url.searchParams.set(PARAM, encodeViewport(o.vb()));
        window.history.replaceState(window.history.state, '', url);
      } catch { /* fail-quiet */ }
    }, SETTLE_MS);
  }));
}
