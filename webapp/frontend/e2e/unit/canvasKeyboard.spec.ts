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
