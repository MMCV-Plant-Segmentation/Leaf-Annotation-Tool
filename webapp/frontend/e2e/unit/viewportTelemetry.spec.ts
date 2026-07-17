/**
 * Unit tests for viewportTelemetry — pins the Phase 3 (feat/annotation-ws) routing:
 *   1. Static regression guard: the module does NOT reference `canvasApi`,
 *      `sendBeacon`, or any bare `fetch` call — telemetry is socket-only.
 *   2. Contract: `createViewportTelemetry` requires a `socket` field in its options
 *      and TypeScript would fail the build if a caller omitted it.
 *
 * We deliberately do NOT drive the reactive graph here — this suite runs BROWSERLESS
 * under Playwright's `unit` project, which resolves `solid-js` to the SSR build
 * (`dist/server.js` — solid's package.json exports `.node` maps to it). In SSR mode
 * `createEffect` + `onMount` are no-ops, so the debounce + heartbeat + flush paths
 * never fire in-node no matter how many microtasks we await. The BEHAVIOURAL flow
 * (a live flush from the canvas UI arriving over the socket) is pinned instead by:
 *   - webapp/tests/test_ws_viewport.py — the server-side WS handler landing rows
 *     via the shared do_create_viewport_events core.
 *   - webapp/frontend/e2e/unit/canvasSocket.spec.ts — socket.post() actually
 *     sends the frame synchronously (works from a beforeunload/pagehide handler).
 * Together those bracket the whole live-flush path end-to-end without needing the
 * SSR-crippled reactive graph in this file.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SRC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'projects', 'viewportTelemetry.ts');

// Strip //-comments AND /*…*/ block comments so the assertions match CODE only
// (the module docstring documents the deleted paths by name — those mentions
// must NOT trip a regression guard). `import type` statements are also stripped
// so a type-only reference to `ViewportSample` from './canvasApi' (still needed
// for the sample shape) doesn't count as a runtime dependency on canvasApi.
function codeOnly(src: string): string {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, '');
  const noLine = noBlock.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  return noLine.split('\n').filter((l) => !/^\s*import\s+type\s/.test(l)).join('\n');
}

test.describe('viewportTelemetry (Phase 3: socket-only)', () => {
  const raw = readFileSync(SRC, 'utf8');
  const src = codeOnly(raw);

  test('has NO runtime call to postViewportEvents (the deleted REST helper)', () => {
    expect(src).not.toMatch(/postViewportEvents/);
  });

  test('has NO runtime reference to sendBeacon (the deleted page-hide fallback)', () => {
    expect(src).not.toMatch(/sendBeacon/);
  });

  test('has NO bare `fetch(` runtime call', () => {
    expect(src).not.toMatch(/\bfetch\s*\(/);
  });

  test('has NO runtime import of canvasApi (only `import type` for the sample shape)', () => {
    // A plain `import { canvasApi } from './canvasApi'` would land in `src` (we
    // stripped only `import type`). Kept `import type` is fine — it's erased at
    // build time, so it can't be a runtime dependency.
    expect(src).not.toMatch(/from\s+['"]\.\/canvasApi['"]/);
  });

  test('DOES import CanvasSocket and calls socket.post for its flush', () => {
    expect(raw).toMatch(/from '\.\/canvasSocket'/);
    expect(raw).toMatch(/socket:\s*CanvasSocket/);
    expect(src).toMatch(/\.socket\.post\(/);
  });

  test('does NOT listen to visibilitychange / pagehide (beacon-only listeners)', () => {
    // These listeners existed only to fire sendBeacon on unload; the socket's
    // beforeunload guard (canvasUnsavedGuard.ts) handles unload for REAL mutations.
    expect(src).not.toMatch(/visibilitychange/);
    expect(src).not.toMatch(/pagehide/);
  });
});
