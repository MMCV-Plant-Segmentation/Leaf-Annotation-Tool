/**
 * Unit tests for canvasUnsavedGuard — the beforeunload warning the annotation canvas
 * mounts on top of `canvasSocket.hasPending()`.
 *
 * Contract pinned here:
 *  - Attaches a `beforeunload` listener on mount; removes it on cleanup.
 *  - When hasPending() returns FALSE, the listener returns undefined and does NOT set
 *    returnValue / call preventDefault — the browser closes without prompting the
 *    user (viewport telemetry alone must NEVER prompt).
 *  - When hasPending() returns TRUE, the listener sets returnValue to the provided
 *    message AND calls preventDefault — the browser shows its standard unsaved-data
 *    prompt.
 *
 * Runs BROWSERLESS (Node). We provide a minimal `window` shim on globalThis that
 * captures the registered listener so we can invoke it directly with a fake event.
 */
import { test, expect } from '@playwright/test';

interface FakeWindow {
  listeners: Record<string, ((e: unknown) => unknown)[]>;
  addEventListener: (ev: string, fn: (e: unknown) => unknown) => void;
  removeEventListener: (ev: string, fn: (e: unknown) => unknown) => void;
}

function installFakeWindow(): FakeWindow {
  const win: FakeWindow = {
    listeners: {},
    addEventListener(ev, fn) { (win.listeners[ev] ??= []).push(fn); },
    removeEventListener(ev, fn) {
      win.listeners[ev] = (win.listeners[ev] ?? []).filter((f) => f !== fn);
    },
  };
  (globalThis as Record<string, unknown>).window = win;
  return win;
}

function uninstallFakeWindow() {
  delete (globalThis as Record<string, unknown>).window;
}

// Simulate a BeforeUnloadEvent — the shape the browser passes.
function fakeUnloadEvent() {
  const ev = {
    _prevented: false,
    returnValue: undefined as string | undefined,
    preventDefault() { ev._prevented = true; },
  };
  return ev;
}

test.describe('canvasUnsavedGuard', () => {
  test.afterEach(() => { uninstallFakeWindow(); });

  test('registers a beforeunload listener on mount and removes it on cleanup', async () => {
    const win = installFakeWindow();
    const { createRoot } = await import('solid-js');
    const { createUnsavedGuard } = await import('../../src/projects/canvasUnsavedGuard');

    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      createUnsavedGuard({ hasPending: () => false, message: () => 'x' });
    });
    // onMount runs on microtask flush.
    await Promise.resolve(); await Promise.resolve();
    expect(win.listeners.beforeunload?.length ?? 0).toBe(1);

    dispose();
    expect(win.listeners.beforeunload?.length ?? 0).toBe(0);
  });

  test('with NO pending op: listener returns undefined and does NOT set returnValue', async () => {
    const win = installFakeWindow();
    const { createRoot } = await import('solid-js');
    const { createUnsavedGuard } = await import('../../src/projects/canvasUnsavedGuard');

    createRoot(() => {
      createUnsavedGuard({ hasPending: () => false, message: () => 'unsaved!' });
    });
    await Promise.resolve(); await Promise.resolve();
    const listener = win.listeners.beforeunload[0];
    const ev = fakeUnloadEvent();
    const rv = listener(ev);
    expect(rv).toBeUndefined();
    expect(ev._prevented).toBe(false);
    expect(ev.returnValue).toBeUndefined();
  });

  test('with a PENDING op: listener calls preventDefault, sets returnValue to the message', async () => {
    const win = installFakeWindow();
    const { createRoot } = await import('solid-js');
    const { createUnsavedGuard } = await import('../../src/projects/canvasUnsavedGuard');

    let pending = true;
    createRoot(() => {
      createUnsavedGuard({ hasPending: () => pending, message: () => 'unsaved annotations!' });
    });
    await Promise.resolve(); await Promise.resolve();
    const listener = win.listeners.beforeunload[0];

    const ev = fakeUnloadEvent();
    const rv = listener(ev);
    expect(ev._prevented).toBe(true);
    expect(ev.returnValue).toBe('unsaved annotations!');
    expect(rv).toBe('unsaved annotations!');

    // Flip to no-pending and re-invoke: no prompt now (guard reads hasPending LATE,
    // at unload time — not at listener-attach time).
    pending = false;
    const ev2 = fakeUnloadEvent();
    const rv2 = listener(ev2);
    expect(rv2).toBeUndefined();
    expect(ev2._prevented).toBe(false);
    expect(ev2.returnValue).toBeUndefined();
  });
});
