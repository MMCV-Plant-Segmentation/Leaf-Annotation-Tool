/**
 * Unit tests for canvasSocket (Phase 3 additions — feat/annotation-ws): fire-and-
 * forget `post()` for viewport telemetry, plus the `hasPending()` predicate that
 * drives the CanvasScreen beforeunload guard.
 *
 * Contract pinned here:
 *  - hasPending() is TRUE from the moment enqueue() reserves a FIFO slot and stays
 *    true until the task's own promise settles (success OR failure). A rapid burst
 *    of clicks that all queue up before the first ack all show as pending — this is
 *    what the beforeunload guard reads at unload time.
 *  - hasPending() is TRUE while a raw send() waits for its ack (undo/redo dispatch
 *    calls send directly, not via enqueue).
 *  - post() NEVER touches hasPending() — telemetry is best-effort and losing an
 *    unflushed sample on unload is fine.
 *  - post() ALWAYS uses ws.send synchronously when the socket is already OPEN (this
 *    is what makes it work from a beforeunload/pagehide handler where an async open
 *    never completes).
 *
 * Runs BROWSERLESS (Node). WebSocket + window are duck-typed on globalThis; the
 * solid-js reactive owner is provided by createRoot so onCleanup has somewhere to
 * register (matches how CanvasScreen instantiates the socket in a component root).
 */
import { test, expect } from '@playwright/test';

// ── Duck-typed globals ─────────────────────────────────────────────────────────

interface FakeWs {
  readyState: number;
  url: string;
  sent: string[];
  onopen?: () => void;
  onerror?: () => void;
  onclose?: () => void;
  onmessage?: (ev: { data: string }) => void;
  addEventListener: (ev: string, fn: (arg?: unknown) => void) => void;
  send: (s: string) => void;
  close: () => void;
  fireMessage: (obj: unknown) => void;
}

const OPEN = 1;

function installFakeGlobals(): { instances: FakeWs[] } {
  const instances: FakeWs[] = [];
  const g = globalThis as Record<string, unknown>;
  g.window = { location: { protocol: 'http:', host: 'localhost:5000' }, devicePixelRatio: 1 };
  class FakeWebSocketCtor {
    static readonly OPEN = OPEN;
    readyState = 0;
    url: string;
    sent: string[] = [];
    listeners: Record<string, ((arg?: unknown) => void)[]> = {};
    constructor(url: string) {
      this.url = url;
      instances.push(this as unknown as FakeWs);
    }
    addEventListener(ev: string, fn: (arg?: unknown) => void) {
      (this.listeners[ev] ??= []).push(fn);
    }
    fire(ev: string, arg?: unknown) { (this.listeners[ev] ?? []).forEach((fn) => fn(arg)); }
    // Convenience: shove state to OPEN and dispatch 'open' — mimic the browser's
    // connection completing.
    openNow() { this.readyState = OPEN; this.fire('open'); }
    fireMessage(obj: unknown) { this.fire('message', { data: JSON.stringify(obj) }); }
    send(s: string) { this.sent.push(s); }
    close() { this.readyState = 3; this.fire('close'); }
  }
  g.WebSocket = FakeWebSocketCtor;
  return { instances };
}

function uninstallFakeGlobals() {
  const g = globalThis as Record<string, unknown>;
  delete g.window;
  delete g.WebSocket;
}

// ── The tests ──────────────────────────────────────────────────────────────────

test.describe('canvasSocket', () => {
  test.afterEach(() => { uninstallFakeGlobals(); });

  test('hasPending() is false at rest, true while an enqueued task is unsettled', async () => {
    const { instances } = installFakeGlobals();
    const { createCanvasSocket } = await import('../../src/projects/canvasSocket');
    const { createRoot } = await import('solid-js');

    let socket!: ReturnType<typeof createCanvasSocket>;
    createRoot(() => { socket = createCanvasSocket({ projectId: () => 'p1', imageId: () => 'i1' }); });

    expect(socket.hasPending()).toBe(false);

    const done = socket.enqueue(async (send) => send('create', { hello: 'world' }));
    // Immediately after enqueue: MUST be pending (guards beforeunload for queued-but-
    // not-yet-sent ops in a rapid burst).
    expect(socket.hasPending()).toBe(true);

    // Let microtasks run so the task actually reaches ws.send.
    await Promise.resolve(); await Promise.resolve();
    // Simulate the server ack: open the ws and echo an ack for the enqueued opId.
    const ws = instances[0];
    ws.openNow();
    // The task ran send() → ws.send(JSON.stringify({type:'op',opId,...})) once open.
    // Drain microtasks so that send() call fires.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(ws.sent).toHaveLength(1);
    const frame = JSON.parse(ws.sent[0]) as { type: string; opId: string };
    expect(frame.type).toBe('op');
    ws.fireMessage({ type: 'ack', opId: frame.opId, result: { ok: true } });

    await done;
    expect(socket.hasPending()).toBe(false);
  });

  test('hasPending() stays true across multiple concurrently-queued tasks; drops to false when all settle', async () => {
    const { instances } = installFakeGlobals();
    const { createCanvasSocket } = await import('../../src/projects/canvasSocket');
    const { createRoot } = await import('solid-js');
    let socket!: ReturnType<typeof createCanvasSocket>;
    createRoot(() => { socket = createCanvasSocket({ projectId: () => 'p1', imageId: () => 'i1' }); });

    const p1 = socket.enqueue(async (send) => send('create', {}));
    const p2 = socket.enqueue(async (send) => send('edit', {}));
    const p3 = socket.enqueue(async (send) => send('erase', {}));
    expect(socket.hasPending()).toBe(true);

    for (let i = 0; i < 5; i++) await Promise.resolve();
    const ws = instances[0];
    ws.openNow();

    // Drain first send.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(ws.sent).toHaveLength(1);
    let f = JSON.parse(ws.sent[0]) as { opId: string };
    ws.fireMessage({ type: 'ack', opId: f.opId, result: 1 });
    await p1;
    expect(socket.hasPending()).toBe(true);  // p2 + p3 still outstanding

    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(ws.sent).toHaveLength(2);
    f = JSON.parse(ws.sent[1]) as { opId: string };
    ws.fireMessage({ type: 'ack', opId: f.opId, result: 2 });
    await p2;
    expect(socket.hasPending()).toBe(true);

    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(ws.sent).toHaveLength(3);
    f = JSON.parse(ws.sent[2]) as { opId: string };
    ws.fireMessage({ type: 'ack', opId: f.opId, result: 3 });
    await p3;
    expect(socket.hasPending()).toBe(false);
  });

  test('hasPending() is true while a raw send() (undo/redo path) awaits its ack', async () => {
    const { instances } = installFakeGlobals();
    const { createCanvasSocket } = await import('../../src/projects/canvasSocket');
    const { createRoot } = await import('solid-js');
    let socket!: ReturnType<typeof createCanvasSocket>;
    createRoot(() => { socket = createCanvasSocket({ projectId: () => 'p1', imageId: () => 'i1' }); });

    const p = socket.send('mutate', { op: 'delete', ids: ['a'] });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    const ws = instances[0];
    ws.openNow();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(socket.hasPending()).toBe(true);

    const f = JSON.parse(ws.sent[0]) as { opId: string };
    ws.fireMessage({ type: 'ack', opId: f.opId, result: { ok: true } });
    await p;
    expect(socket.hasPending()).toBe(false);
  });

  test('post() sends a fire-and-forget frame SYNCHRONOUSLY when the socket is already OPEN', async () => {
    const { instances } = installFakeGlobals();
    const { createCanvasSocket } = await import('../../src/projects/canvasSocket');
    const { createRoot } = await import('solid-js');
    let socket!: ReturnType<typeof createCanvasSocket>;
    createRoot(() => { socket = createCanvasSocket({ projectId: () => 'p1', imageId: () => 'i1' }); });

    // Open the socket by kicking off an op, letting it drain, then draining the ack.
    const p = socket.send('create', {});
    for (let i = 0; i < 5; i++) await Promise.resolve();
    const ws = instances[0];
    ws.openNow();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    const f = JSON.parse(ws.sent[0]) as { opId: string };
    ws.fireMessage({ type: 'ack', opId: f.opId, result: {} });
    await p;
    ws.sent.length = 0;  // reset for the post() assertion

    // Sync path: post() writes to ws.send BEFORE returning — no awaits in between.
    // (This is what makes it work from a beforeunload/pagehide handler.)
    socket.post('viewport', { projectId: 'p1', imageId: 'i1', events: [{ x: 1 }] });
    expect(ws.sent).toHaveLength(1);
    const frame = JSON.parse(ws.sent[0]) as { type: string; projectId: string; events: unknown[] };
    expect(frame.type).toBe('viewport');
    expect(frame.projectId).toBe('p1');
    expect(frame.events).toHaveLength(1);
  });

  test('post() does NOT count toward hasPending() — telemetry never triggers the unload guard', async () => {
    const { instances } = installFakeGlobals();
    const { createCanvasSocket } = await import('../../src/projects/canvasSocket');
    const { createRoot } = await import('solid-js');
    let socket!: ReturnType<typeof createCanvasSocket>;
    createRoot(() => { socket = createCanvasSocket({ projectId: () => 'p1', imageId: () => 'i1' }); });

    // Open the socket by driving one op through it.
    const p = socket.send('create', {});
    for (let i = 0; i < 5; i++) await Promise.resolve();
    const ws = instances[0];
    ws.openNow();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    const f = JSON.parse(ws.sent[0]) as { opId: string };
    ws.fireMessage({ type: 'ack', opId: f.opId, result: {} });
    await p;
    expect(socket.hasPending()).toBe(false);

    // Blast a burst of fire-and-forget viewport frames — hasPending stays false.
    for (let i = 0; i < 10; i++) socket.post('viewport', { events: [{ i }] });
    expect(socket.hasPending()).toBe(false);
  });

  test('post() best-effort opens lazily when the socket is not open yet (no throw)', async () => {
    installFakeGlobals();
    const { createCanvasSocket } = await import('../../src/projects/canvasSocket');
    const { createRoot } = await import('solid-js');
    let socket!: ReturnType<typeof createCanvasSocket>;
    createRoot(() => { socket = createCanvasSocket({ projectId: () => 'p1', imageId: () => 'i1' }); });

    // No prior op → socket has never opened. post() must not throw and must not
    // become "pending" (it's best-effort; unload-loss is acceptable).
    expect(() => socket.post('viewport', { events: [] })).not.toThrow();
    expect(socket.hasPending()).toBe(false);
  });
});
