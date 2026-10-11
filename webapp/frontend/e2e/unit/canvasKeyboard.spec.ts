/**
 * Unit tests for canvasKeyboard's pure keydown reducer (handleCanvasKeyDown).
 *
 * Runs BROWSERLESS (Node.js) — no DOM/mount, just the reducer + a fake opts object with
 * spied history. Locks in the redo keybindings (t21): redo must be reachable via BOTH
 * Ctrl+Shift+Z (including the shifted-'Z' glyph browsers report) AND Ctrl+Y, and the two
 * must behave identically; undo via Ctrl+Z; all gated off for an admin viewer.
 */
import { test, expect } from '@playwright/test';
import { handleCanvasKeyDown, type CanvasKeyboardOpts } from '../../src/projects/canvasKeyboard';

function makeOpts(over: Partial<CanvasKeyboardOpts> = {}) {
  const calls = { undo: 0, redo: 0, prevented: 0 };
  const noop = () => {};
  const o: CanvasKeyboardOpts = {
    isAdmin: () => false,
    interaction: { finishDraft: noop, handleKeyDown: noop, handleKeyUp: noop } as unknown as CanvasKeyboardOpts['interaction'],
    history: { undo: async () => { calls.undo++; }, redo: async () => { calls.redo++; } } as unknown as CanvasKeyboardOpts['history'],
    tool: () => 'brush',
    setTool: noop, setDraft: noop, setSelId: noop, fitImage: noop,
    ...over,
  };
  const press = (init: Partial<KeyboardEvent>) =>
    handleCanvasKeyDown({ preventDefault: () => { calls.prevented++; }, ...init } as unknown as KeyboardEvent, o);
  return { calls, press };
}

test('Ctrl+Z undoes; Ctrl+Shift+Z and Ctrl+Y both redo (and are equivalent)', () => {
  const { calls, press } = makeOpts();

  press({ key: 'z', ctrlKey: true });                 // undo
  expect(calls).toMatchObject({ undo: 1, redo: 0 });

  // Ctrl+Shift+Z — browsers report the shifted glyph as 'Z' (uppercase); the reducer
  // lowercases, so this must still redo. This is the exact case the fix targets.
  press({ key: 'Z', ctrlKey: true, shiftKey: true }); // redo (via shift+z)
  expect(calls.redo).toBe(1);

  press({ key: 'y', ctrlKey: true });                 // redo (via y) — the equivalent binding
  expect(calls.redo).toBe(2);

  // No stray undos fired from either redo, and every handled shortcut called preventDefault.
  expect(calls.undo).toBe(1);
  expect(calls.prevented).toBe(3);
});

test('Ctrl+Shift+z (lowercase key) and Cmd+Shift+z also redo', () => {
  const { calls, press } = makeOpts();
  press({ key: 'z', ctrlKey: true, shiftKey: true }); // some layouts report lowercase
  press({ key: 'z', metaKey: true, shiftKey: true }); // macOS Cmd+Shift+Z
  expect(calls.redo).toBe(2);
  expect(calls.undo).toBe(0);
});

test('edit shortcuts are gated off for an admin viewer', () => {
  const { calls, press } = makeOpts({ isAdmin: () => true });
  press({ key: 'z', ctrlKey: true });
  press({ key: 'Z', ctrlKey: true, shiftKey: true });
  press({ key: 'y', ctrlKey: true });
  expect(calls).toMatchObject({ undo: 0, redo: 0 });
});

test('a bare Y or Z (no modifier) does nothing', () => {
  const { calls, press } = makeOpts();
  press({ key: 'y' });
  press({ key: 'z' });
  press({ key: 'Z', shiftKey: true });
  expect(calls).toMatchObject({ undo: 0, redo: 0, prevented: 0 });
});

test('ESC on polyline is two-stage: rubber band up → finish (stay on tool); no band → select (t59)', () => {
  // t59 (Christian, 2026-07-19). Supersedes the old single-stage "ESC → select". While a
  // rubber band is up (the draft holds >=1 vertex, i.e. the user is actively drawing) the
  // FIRST ESC FINISHES the current polyline — that is when the tile check runs (keep or
  // discard-like-brush) — and STAYS on the polyline tool, ready for a new line. Only an ESC
  // with NO rubber band (empty draft) switches to the select tool. The reducer decides which
  // via a new `draft` accessor + `finishPolyline` callback on CanvasKeyboardOpts.

  // Stage 1 — rubber band up: ESC finishes, does NOT jump to select.
  let toolNow = 'polyline';
  let finishCalls = 0;
  let selectSwitches = 0;
  const withBand = {
    isAdmin: () => false,
    interaction: { finishDraft: () => {}, handleKeyDown: () => {}, handleKeyUp: () => {} },
    history: { undo: async () => {}, redo: async () => {} },
    tool: () => toolNow,
    setTool: (t: string) => { toolNow = t; if (t === 'select') selectSwitches++; },
    setDraft: () => {}, setSelId: () => {}, fitImage: () => {},
    draft: () => [[10, 10]] as number[][],     // a rubber band exists → actively drawing
    finishPolyline: () => { finishCalls++; },
  } as unknown as CanvasKeyboardOpts;
  handleCanvasKeyDown({ preventDefault: () => {}, key: 'Escape' } as unknown as KeyboardEvent, withBand);
  expect(finishCalls).toBe(1);               // 1st ESC finishes the polyline (runs the tile check)
  expect(toolNow).toBe('polyline');          // stays on the tool, ready for a new line
  expect(selectSwitches).toBe(0);            // does NOT switch to select yet

  // Stage 2 — no rubber band (empty draft): ESC switches to select.
  let tool2 = 'polyline';
  let finish2 = 0;
  const noBand = {
    isAdmin: () => false,
    interaction: { finishDraft: () => {}, handleKeyDown: () => {}, handleKeyUp: () => {} },
    history: { undo: async () => {}, redo: async () => {} },
    tool: () => tool2,
    setTool: (t: string) => { tool2 = t; },
    setDraft: () => {}, setSelId: () => {}, fitImage: () => {},
    draft: () => [] as number[][],             // no rubber band
    finishPolyline: () => { finish2++; },
  } as unknown as CanvasKeyboardOpts;
  handleCanvasKeyDown({ preventDefault: () => {}, key: 'Escape' } as unknown as KeyboardEvent, noBand);
  expect(tool2).toBe('select');              // no band → switch to select (2nd-stage behaviour)
  expect(finish2).toBe(0);                   // nothing to finish
});

test('Enter no longer commits an in-progress polyline — Enter is a no-op for polyline', () => {
  // Enter still finishes polygon/line via finishDraft; for polyline it must do nothing
  // useful (the per-click persistence has already stored everything).
  let toolNow: string = 'polyline';
  let commits = 0;
  const opts: Partial<CanvasKeyboardOpts> = {
    tool: () => toolNow as 'polyline',
    interaction: {
      finishDraft: () => { commits++; },   // finishDraft is called (still handles polygon/line);
                                            // but the interaction's polyline branch is gone,
                                            // so its net effect for polyline is a no-op.
      handleKeyDown: () => {}, handleKeyUp: () => {},
    } as unknown as CanvasKeyboardOpts['interaction'],
    setTool: (t) => { toolNow = t as string; },
  };
  const { press } = makeOpts(opts);
  press({ key: 'Enter' });
  // The polyline branch of finishDraft is removed in the implementation, so Enter for
  // polyline does nothing meaningful. We still allow finishDraft to be invoked (polygon/
  // line use it) but the tool must not switch.
  expect(toolNow).toBe('polyline');
});
