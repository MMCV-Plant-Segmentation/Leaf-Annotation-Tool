import { onCleanup, onMount } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { Tool } from './canvasShapes';
import type { createCanvasInteraction } from './canvasInteraction';
import type { createCanvasHistory } from './canvasHistory';

export interface CanvasKeyboardOpts {
  isAdmin: () => boolean;
  interaction: ReturnType<typeof createCanvasInteraction>;
  history: ReturnType<typeof createCanvasHistory>;
  tool: Accessor<Tool>;
  setTool: (t: Tool) => void;
  setDraft: (d: number[][]) => void;
  /** t50 phase 2b: reset alongside `draft` (parallel per-point vertex refs). Optional so
   * pre-existing callers/tests without snapping wiring keep working unchanged. */
  setDraftRefs?: (r: (string | null)[]) => void;
  setSelId: (id: string | null) => void;
  fitImage: () => void;
  /** Current polyline rubber-band vertices (t59, two-stage ESC). */
  draft: Accessor<number[][]>;
  /** Finish the in-progress polyline: runs the tile check, stays on the tool (t59). */
  finishPolyline: () => void;
}

/**
 * Window-level keydown/keyup wiring for the canvas: undo/redo (Ctrl+Z / Ctrl+Shift+Z /
 * Ctrl+Y), Enter (finish draft), Escape (clear draft / deselect), Ctrl+0 (fit). Split out
 * of CanvasScreen.tsx to keep it under the file's line limit; registers/tears down its own
 * listeners via onMount/onCleanup so the caller just invokes this once.
 */
/**
 * The pure keydown reducer (extracted from the window listener below so it's unit-testable
 * without a DOM/mount — see e2e/unit/canvasKeyboard.spec.ts). Behaviour is identical to what
 * the window listener dispatched. Redo is reachable via BOTH Ctrl+Shift+Z and Ctrl+Y; the
 * Shift case relies on `key.toLowerCase()` because browsers report the shifted glyph ('Z').
 */
export function handleCanvasKeyDown(e: KeyboardEvent, o: CanvasKeyboardOpts): void {
  if (!o.isAdmin()) {
    // Edit shortcuts only for the annotator who owns this work — never for an admin viewer.
    if (e.key === 'Enter') o.interaction.finishDraft();
    // NB: with Shift held, browsers report e.key as the shifted glyph ('Z', not 'z') —
    // compare case-insensitively so Ctrl+Shift+Z actually fires (pre-existing bug found
    // while wiring relabel into undo/redo, Phase 2c: the literal 'z' check meant redo
    // was reachable only via the Ctrl+Y fallback below).
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && key === 'z') { e.preventDefault(); void o.history.undo(); }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && key === 'z') { e.preventDefault(); void o.history.redo(); }
    if (e.ctrlKey && !e.metaKey && key === 'y') { e.preventDefault(); void o.history.redo(); }
  }
  // Non-edit keys remain available to everyone: Escape (clear draft), Ctrl+0 (fit).
  if (e.key === 'Escape') {
    if (o.tool() === 'select') o.setSelId(null);
    // Polyline (t59, two-stage ESC, 2026-07-19): every click is already persisted
    // per-click, so ESC never discards clicks — it decides whether to FINISH (run the
    // deferred tile check) or DESELECT the tool. If a rubber band is up (draft holds
    // >=1 vertex, i.e. actively drawing) the first ESC finishes the current polyline
    // and STAYS on the tool, ready for a new line. Only an ESC with no rubber band
    // (empty draft) falls through to the old behaviour of switching to select.
    else if (o.tool() === 'polyline') {
      if (o.draft().length > 0) { o.setDraft([]); o.setDraftRefs?.([]); o.finishPolyline(); }
      else { o.setDraft([]); o.setDraftRefs?.([]); o.setTool('select'); }
    }
    else { o.setDraft([]); o.setDraftRefs?.([]); o.setTool('pan'); }
  }
  if ((e.ctrlKey || e.metaKey) && e.key === '0') { e.preventDefault(); o.fitImage(); }
  o.interaction.handleKeyDown(e);
}

export function createCanvasKeyboard(o: CanvasKeyboardOpts): void {
  const onKeyDown = (e: KeyboardEvent) => handleCanvasKeyDown(e, o);
  const onKeyUp = (e: KeyboardEvent) => o.interaction.handleKeyUp(e);
  onMount(() => { window.addEventListener('keydown', onKeyDown); window.addEventListener('keyup', onKeyUp); });
  onCleanup(() => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp); });
}
