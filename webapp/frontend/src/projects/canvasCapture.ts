// t141: max-rate rich capture for a brush stroke. `getCoalescedEvents()` yields every
// inter-frame pointer sample (the ceiling on iPad WebKit — the primary device); each is
// stored in IMAGE space with a relative timestamp + pressure/tilt/twist + pointerType.
// Additive to the coarse draft points — never affects geometry.

/** One raw max-rate input sample. `t` is ms from the stroke's first sample; `pressure`/
 * `tiltX`/`tiltY`/`twist` are the Pointer Events values (0 for devices that don't report
 * them, e.g. mouse); `pointerType` is a study stratification variable (mouse | pen | touch). */
export type PointerSample = {
  x: number; y: number; t: number; pressure: number;
  tiltX: number; tiltY: number; twist: number; pointerType: string;
};

/** Accumulates the rich stream for ONE stroke. `reset()` at pointer-down, `collect(e)` on
 * every down/move/up (coalesced sub-samples expanded), `take()` at commit. `toImage` maps
 * client px → image px (the canvas CTM transform). */
export function createSampleCapture(toImage: (clientX: number, clientY: number) => [number, number]) {
  let samples: PointerSample[] = [];
  let t0: number | null = null;
  return {
    reset() { samples = []; t0 = null; },
    collect(e: PointerEvent) {
      const co = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
      for (const ev of (co.length ? co : [e])) {
        if (t0 === null) t0 = ev.timeStamp;
        const [ix, iy] = toImage(ev.clientX, ev.clientY);
        samples.push({ x: ix, y: iy, t: ev.timeStamp - t0, pressure: ev.pressure,
          tiltX: ev.tiltX, tiltY: ev.tiltY, twist: ev.twist, pointerType: ev.pointerType });
      }
    },
    take: () => samples,
  };
}

/** t157: iPad Safari delivers every Apple Pencil pointermove TWICE (identical timestamp, position
 * and pressure — measured on the calibration page; touch/mouse don't). Returns a predicate that is
 * true for such an exact repeat of the same pointer's previous move, so the caller drops it before
 * it doubles the draft points and the captured samples. */
export function createRepeatFilter() {
  const last = new Map<number, string>();
  return (e: PointerEvent): boolean => {
    const key = `${e.timeStamp}|${e.clientX}|${e.clientY}|${e.pressure}`;
    if (last.get(e.pointerId) === key) return true;
    last.set(e.pointerId, key);
    return false;
  };
}
