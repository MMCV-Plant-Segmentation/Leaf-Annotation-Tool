import { createSignal } from 'solid-js';

/**
 * t161 — opt-in PEN MODE, persisted per device (localStorage; wrapped in try/catch since some
 * browsers throw on access in certain contexts — default stays off on any failure).
 *
 * Default (off): the pen is a generic pointer like a finger — mouse is the main target.
 * ON: only the pen draws (touch only pans/pinches, with every tool); mouse is unaffected.
 * See canvasInteraction.ts for the touch-gating this drives.
 */
const STORAGE_KEY = 'ht.penMode';

function readStored(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

const [penMode, setPenModeSignal] = createSignal<boolean>(readStored());

/** Reactive accessor — read anywhere (e.g. canvasInteraction, CanvasToolbar's badge). */
export { penMode };

/** Reactive, non-hook-style read for plain .ts callers that don't want the accessor type. */
export function isPenMode(): boolean {
  return penMode();
}

export function setPenMode(on: boolean): void {
  setPenModeSignal(on);
  try {
    localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
  } catch {
    // ignore — pen mode just won't persist this device.
  }
}

export function togglePenMode(): void {
  setPenMode(!penMode());
}
