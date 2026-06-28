/**
 * Small helpers for "lazy-load on scroll-settle": a debounce plus a visibility tracker
 * that only commits keys to load once the viewport has stopped moving for a brief linger,
 * so rapidly scrolling past images doesn't fire a request for each one.
 *
 * Kept framework-free and pure so the debounce/flush logic is unit-testable without a DOM.
 */

/** Classic trailing debounce: only the last call within `ms` runs, after `ms` of quiet. */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void, ms: number,
): ((...args: A) => void) & { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wrapped = (...args: A) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; fn(...args); }, ms);
  };
  wrapped.cancel = () => { if (timer !== undefined) { clearTimeout(timer); timer = undefined; } };
  return wrapped;
}

/**
 * Tracks which keys are currently visible and, after the scroll settles (debounced),
 * reports the union of everything that has *settled* visible so far via `onSettle`.
 * A key that flashes through the viewport between settles is never reported.
 */
export function createSettleTracker(
  onSettle: (loaded: ReadonlySet<string>) => void, ms = 150,
) {
  const visible = new Set<string>();   // currently intersecting
  const loaded = new Set<string>();    // settled-visible at least once
  const flush = debounce(() => {
    let changed = false;
    for (const k of visible) {
      if (!loaded.has(k)) { loaded.add(k); changed = true; }
    }
    if (changed) onSettle(new Set(loaded));
  }, ms);

  return {
    setVisible(key: string, isVisible: boolean) {
      if (isVisible) visible.add(key); else visible.delete(key);
      flush();
    },
    /** For tests: force the pending flush immediately. */
    flushNow() { flush.cancel(); for (const k of visible) loaded.add(k); onSettle(new Set(loaded)); },
    cancel() { flush.cancel(); },
  };
}
