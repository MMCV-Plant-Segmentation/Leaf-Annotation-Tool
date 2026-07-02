import { createSignal, createEffect, on } from 'solid-js';
import { imageUrls } from './api';

// BUGS #20: SVG <image onLoad> fires once the resource bytes have arrived, but before the
// browser has decoded/rasterized the (large) overview bitmap — so the vector overlay, which
// paints instantly, can still beat the image onto the screen by a frame. Preloading the same
// URL through a plain HTMLImageElement and awaiting decode() blocks until the bitmap is
// actually ready to paint, so gating the overlay on this instead removes that race.
//
// Resolution order isn't guaranteed if images advance quickly, so every resolved decode is
// checked against the *current* imageId before flipping the signal — a stale decode for a
// previously-viewed image can never reveal the overlay for the image the user has since
// moved to. The reset-on-id-change stays keyed purely to image identity, so panning/zooming
// an already-loaded image never re-triggers it (no flicker).
export function createImageDecodeGate(imageId: () => string | undefined) {
  const [loaded, setLoaded] = createSignal(false);

  createEffect(on(imageId, (id) => {
    setLoaded(false);
    if (!id) return;
    const img = new Image();
    img.src = imageUrls.overview(id);
    const reveal = () => { if (imageId() === id) setLoaded(true); };
    (img.decode ? img.decode() : Promise.resolve()).then(reveal, reveal);
  }));

  return loaded;
}
