// t157: measures the display refresh rate from requestAnimationFrame cadence (pointer events on
// WebKit are typically dispatched once per frame, so this bounds the un-coalesced event rate).
import { createSignal } from 'solid-js';

const WINDOW = 60;  // frames averaged per reading

export function createRefreshMeter() {
  const [hz, setHz] = createSignal(0);
  const stamps: number[] = [];
  let raf = 0;
  const tick = (now: number) => {
    stamps.push(now);
    if (stamps.length > WINDOW) stamps.shift();
    if (stamps.length === WINDOW) {
      const span = stamps[WINDOW - 1] - stamps[0];
      if (span > 0) setHz(Math.round(((WINDOW - 1) * 1000) / span));
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return { hz, stop: () => cancelAnimationFrame(raf) };
}
