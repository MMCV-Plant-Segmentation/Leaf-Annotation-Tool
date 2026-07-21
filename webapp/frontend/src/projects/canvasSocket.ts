/**
 * Canvas WebSocket client — Phase 1+2 of the annotation-ops rebuild (feat/annotation-ws).
 *
 * The single ORDERED channel every mutation op (create / edit / reverse / erase / relabel
 * / mutate / reverse_merge) funnels through.
 * The server (webapp/asgi.py) processes ops strictly sequentially per connection; this
 * module mirrors that on the client by serialising every enqueue()-scheduled task on ONE
 * promise chain, and by waiting for each op's ack (or error) before the next send is
 * released. Together those give a per-canvas FIFO with request/response semantics.
 *
 * WHY: pre-Phase-1 the click-persistence promise chain (canvasPolylinePersist.ts) and the
 * client's undo/redo dispatch were TWO independent client-side sequences racing on the
 * same annotation — Ctrl+Z during an in-flight editStroke landed on a partial history and
 * left orphan masks. Deleting both client chains and routing everything through this one
 * socket-owned queue removes the race by construction.
 *
 * API:
 *   send<T>(op, payload)   — ONE op frame; resolves with ack/error result (never rejects).
 *   enqueue<T>(task(send)) — reserve the next FIFO slot for a task that decides based on
 *                             state settled AFTER the previous op's ack (e.g. polyline
 *                             session: "did click #1 return me a strokeId to extend?").
 *   post(type, payload)    — fire-and-forget, no ack, no FIFO slot. Sync ws.send() when
 *                             the socket is ALREADY OPEN (works on unload); else best-
 *                             effort async open-then-send. Never counts toward hasPending.
 *   hasPending()           — true iff a mutation op has been enqueued or sent and has NOT
 *                             yet acked/errored. Drives the CanvasScreen beforeunload
 *                             guard so we warn the user before they drop unsaved
 *                             annotation data on the floor. post() is best-effort → false.
 *   close()                — tear down (canvas unmount / image change).
 */
import { onCleanup } from 'solid-js';

export type CanvasOp =
  | 'create' | 'edit' | 'reverse' | 'splice'
  // Phase 2 (feat/annotation-ws): the remaining mutations, all on the same FIFO channel.
  | 'erase' | 'relabel' | 'mutate' | 'reverse_merge'
  // t50 phase 3b: SHARED vertex drag → move op (do_move_vertex re-fuses every sharer).
  | 'moveVertex';

/** Ack: {ok:true, result} carries the server's delta (same shape the REST endpoint
 * returned). Error: {ok:false, message} carries the server's message (or a synthesized
 * one for transport failures). Every send() resolves — it NEVER rejects — so callers can
 * write single-branch code without a stray unhandled rejection breaking the chain. */
export type SocketAck<T = unknown> =
  | { ok: true; result: T }
  | { ok: false; message: string };

export type SocketSend = <T = unknown>(op: CanvasOp, payload: unknown) => Promise<SocketAck<T>>;

export interface CanvasSocketOpts {
  projectId: () => string | undefined;
  imageId:   () => string | undefined;
}

export interface CanvasSocket {
  send:    SocketSend;
  enqueue: <T>(task: (send: SocketSend) => Promise<T>) => Promise<T>;
  /** Fire-and-forget frame (no ack, no FIFO). See module docstring for semantics. */
  post:    (type: string, payload: Record<string, unknown>) => void;
  /** True while any mutation op is enqueued/in-flight (drives unload guard). */
  hasPending: () => boolean;
  close:   () => void;
}

export function createCanvasSocket(o: CanvasSocketOpts): CanvasSocket {
  let ws: WebSocket | null = null;
  let connecting: Promise<WebSocket> | null = null;
  let disposed = false;
  const pending = new Map<string, (r: SocketAck) => void>();
  // The one FIFO chain. Every enqueue() task runs after the previous task's promise
  // settles (success or failure); every raw send() awaits its own ack before returning
  // — so the next enqueue task's `send()` naturally can't fire until the current one is
  // done. This is the ordering the whole design hangs on.
  let chain: Promise<unknown> = Promise.resolve();
  // Pending-mutation counter — bumped when a task is enqueued, dropped when it settles.
  // Drives hasPending() for the CanvasScreen beforeunload guard. Also counts raw
  // send()s (used by history undo/redo which call send directly, not via enqueue).
  // Fire-and-forget viewport telemetry does NOT touch this counter.
  let enqueuedTasks = 0;

  const url = (): string | null => {
    const pid = o.projectId(); const iid = o.imageId();
    if (!pid || !iid) return null;
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const q = new URLSearchParams({ projectId: pid, imageId: iid }).toString();
    return `${proto}//${window.location.host}/ws/canvas?${q}`;
  };

  const open = (): Promise<WebSocket> => {
    if (disposed) return Promise.reject(new Error('canvasSocket: disposed'));
    if (ws && ws.readyState === WebSocket.OPEN) return Promise.resolve(ws);
    if (connecting) return connecting;
    const target = url();
    if (!target) return Promise.reject(new Error('canvasSocket: no projectId/imageId'));
    connecting = new Promise<WebSocket>((resolve, reject) => {
      const s = new WebSocket(target);
      s.addEventListener('open', () => { ws = s; connecting = null; resolve(s); });
      s.addEventListener('error', () => {
        connecting = null;
        // Fail every waiter so the chain can move on rather than deadlock.
        for (const resolver of pending.values()) resolver({ ok: false, message: 'canvasSocket: transport error' });
        pending.clear();
        reject(new Error('canvasSocket: transport error'));
      });
      s.addEventListener('close', () => {
        if (ws === s) ws = null;
        for (const resolver of pending.values()) resolver({ ok: false, message: 'canvasSocket: closed' });
        pending.clear();
      });
      s.addEventListener('message', (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if ((msg.type === 'ack' || msg.type === 'error') && msg.opId) {
            const resolver = pending.get(msg.opId);
            if (resolver) {
              pending.delete(msg.opId);
              resolver(msg.type === 'ack'
                ? { ok: true, result: msg.result }
                : { ok: false, message: msg.message ?? 'op failed' });
            }
          }
        } catch { /* malformed frame — ignore */ }
      });
    });
    return connecting;
  };

  const send: SocketSend = async (op, payload) => {
    if (disposed) return { ok: false, message: 'canvasSocket: disposed' };
    let socket: WebSocket;
    try { socket = await open(); } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
    return new Promise((resolve) => {
      const opId = (globalThis.crypto?.randomUUID?.() as string | undefined) ?? Math.random().toString(36).slice(2);
      pending.set(opId, resolve as (r: SocketAck) => void);
      try {
        socket.send(JSON.stringify({ type: 'op', opId, op, payload }));
      } catch (e) {
        pending.delete(opId);
        resolve({ ok: false, message: (e as Error).message });
      }
    });
  };

  const enqueue = <T,>(task: (s: SocketSend) => Promise<T>): Promise<T> => {
    // Count the task as pending from the moment it's enqueued (NOT from when it starts
    // running) — a rapid burst of clicks that all queue up before the first ack must
    // all show as pending, else the beforeunload guard could miss queued-but-not-yet-
    // sent ops. Decrement when the task's own promise settles.
    enqueuedTasks += 1;
    const run = () => task(send);
    // Serial run: `then(run, run)` runs the next task regardless of the prior's outcome,
    // so a single failure doesn't lock the chain. The chain tracks the task's completion
    // (not its resolved VALUE) so subsequent tasks wait for it to settle.
    const p = chain.then(run, run);
    // Track completion for the counter separately from the ordering chain so a caller
    // that throws inside `task` still drops its slot.
    p.then(() => { enqueuedTasks -= 1; }, () => { enqueuedTasks -= 1; });
    chain = p.then(() => undefined, () => undefined);
    return p;
  };

  const post = (type: string, payload: Record<string, unknown>): void => {
    if (disposed) return;
    const frame = JSON.stringify({ type, ...payload });
    // Sync path: if the socket is ALREADY OPEN we can send from a beforeunload/pagehide
    // handler and the browser will actually put it on the wire. This is why we DON'T
    // await open() — an async open never completes on unload.
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(frame); } catch { /* fail-quiet: telemetry is best-effort */ }
      return;
    }
    // Async fallback: open lazily and send once ready. If the tab is unloading this
    // will simply never complete — acceptable for viewport telemetry (no annotation
    // happened; losing the last sample is fine).
    open().then((s) => { try { s.send(frame); } catch { /* fail-quiet */ } })
          .catch(() => { /* fail-quiet: telemetry never surfaces errors to the user */ });
  };

  const hasPending = (): boolean => pending.size > 0 || enqueuedTasks > 0;

  const close = () => {
    disposed = true;
    if (ws) { try { ws.close(); } catch { /* ignore */ } }
    ws = null;
    for (const resolver of pending.values()) resolver({ ok: false, message: 'canvasSocket: disposed' });
    pending.clear();
  };

  onCleanup(close);

  return { send, enqueue, post, hasPending, close };
}
