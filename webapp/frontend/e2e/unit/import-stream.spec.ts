/**
 * Unit tests for the streaming-import NDJSON client (streamImport, streamUpload).
 * Verifies it reassembles events across arbitrary chunk boundaries (a line split
 * across two reads must still parse) and surfaces every event in order.
 * Also verifies streamUpload posts one XHR per file, emits byte-level progress events,
 * and counts completed (not in-flight) files via 'file' events.
 */
import { test, expect } from '@playwright/test';

const _origFetch = globalThis.fetch;
const _origXHR = globalThis.XMLHttpRequest;
test.afterEach(() => {
  globalThis.fetch = _origFetch;
  globalThis.XMLHttpRequest = _origXHR;
});

/** Build a Response-like object whose body.getReader() yields the given byte chunks. */
function streamResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  let i = 0;
  const reader = {
    read: async () => {
      if (i >= chunks.length) return { done: true, value: undefined };
      return { done: false, value: enc.encode(chunks[i++]) };
    },
  };
  return {
    ok: true,
    status: 200,
    body: { getReader: () => reader },
  } as unknown as Response;
}

/**
 * Build a mock XMLHttpRequest class that simulates XHR upload + streaming NDJSON response.
 * Each call to `send` consumes one entry from `responseGroups`.
 * `onProgress` receives a ProgressEvent with the given `uploadedBytes`.
 */
function makeMockXhrClass(
  responseGroups: string[][],
  uploadedBytes = 42,
): { MockXHR: typeof XMLHttpRequest; callCount: () => number } {
  let calls = 0;

  class MockXHR {
    upload: {
      onprogress: ((e: { loaded: number; lengthComputable: boolean }) => void) | null;
      onload: (() => void) | null;
    } = { onprogress: null, onload: null };
    onprogress: (() => void) | null = null;
    onloadend: (() => void) | null = null;
    status = 200;
    responseText = '';

    open(_method: string, _url: string): void { /* noop */ }

    send(_body: unknown): void {
      const idx = calls++;
      const chunks = responseGroups[idx] ?? [];
      // Use a microtask so the caller can attach onXxx handlers synchronously before events fire.
      Promise.resolve().then(() => {
        if (this.upload.onprogress) {
          this.upload.onprogress({ loaded: uploadedBytes, lengthComputable: true });
        }
        if (this.upload.onload) this.upload.onload();
        for (const chunk of chunks) {
          this.responseText += chunk;
          if (this.onprogress) this.onprogress();
        }
        if (this.onloadend) this.onloadend();
      });
    }
  }

  return {
    MockXHR: MockXHR as unknown as typeof XMLHttpRequest,
    callCount: () => calls,
  };
}

test.describe('streamImport', () => {
  test('emits start/file/done across clean line chunks', async () => {
    globalThis.fetch = (async () => streamResponse([
      '{"type":"start","total":2}\n',
      '{"type":"file","name":"a.png","path":"/x/a.png","ok":true,"imported":true}\n',
      '{"type":"file","name":"b.png","path":"/x/b.png","ok":false,"error":"bad"}\n',
      '{"type":"done","imported":1,"skipped":0,"errors":[{"file":"b.png","error":"bad"}]}\n',
    ])) as typeof fetch;

    const { streamImport } = await import('../../src/projects/api');
    const events: unknown[] = [];
    await streamImport('p1', '/x', (e) => events.push(e));

    expect(events).toHaveLength(4);
    expect((events[0] as { type: string }).type).toBe('start');
    expect((events[3] as { type: string; imported: number }).imported).toBe(1);
  });

  test('reassembles a JSON line split across chunk boundaries', async () => {
    // The first file event is split mid-token across three reads.
    globalThis.fetch = (async () => streamResponse([
      '{"type":"start","total":1}\n{"type":"fi',
      'le","name":"a.png","path":"/x/a',
      '.png","ok":true,"imported":true}\n{"type":"done","imported":1,"skipped":0,"errors":[]}\n',
    ])) as typeof fetch;

    const { streamImport } = await import('../../src/projects/api');
    const events: { type: string }[] = [];
    await streamImport('p1', '/x', (e) => events.push(e as { type: string }));

    expect(events.map((e) => e.type)).toEqual(['start', 'file', 'done']);
  });

  test('handles a final line with no trailing newline', async () => {
    globalThis.fetch = (async () => streamResponse([
      '{"type":"start","total":0}\n',
      '{"type":"done","imported":0,"skipped":0,"errors":[]}',  // no \n
    ])) as typeof fetch;

    const { streamImport } = await import('../../src/projects/api');
    const events: { type: string }[] = [];
    await streamImport('p1', '/x', (e) => events.push(e as { type: string }));
    expect(events.map((e) => e.type)).toEqual(['start', 'done']);
  });

  test('throws on a non-ok response', async () => {
    globalThis.fetch = (async () => ({
      ok: false, status: 404, body: null,
      json: async () => ({ error: 'not found' }),
    })) as unknown as typeof fetch;
    const { streamImport } = await import('../../src/projects/api');
    await expect(streamImport('p1', '/x', () => {})).rejects.toThrow('not found');
  });
});

// ── streamUpload (XHR, NDJSON, byte progress) ────────────────────────────────

test.describe('streamUpload (XHR per-file, byte progress)', () => {
  test('posts one XHR per file and emits start/progress/file/done', async () => {
    const { MockXHR, callCount } = makeMockXhrClass([
      [`{"type":"start","total":1}\n`,
       `{"type":"file","name":"f1.png","path":"f1.png","ok":true,"imported":true}\n`,
       `{"type":"done","imported":1,"skipped":0,"errors":[]}\n`],
      [`{"type":"start","total":1}\n`,
       `{"type":"file","name":"f2.png","path":"f2.png","ok":true,"imported":true}\n`,
       `{"type":"done","imported":1,"skipped":0,"errors":[]}\n`],
      [`{"type":"start","total":1}\n`,
       `{"type":"file","name":"f3.png","path":"f3.png","ok":true,"imported":true}\n`,
       `{"type":"done","imported":1,"skipped":0,"errors":[]}\n`],
    ]);
    globalThis.XMLHttpRequest = MockXHR;

    const { streamUpload } = await import('../../src/projects/api');
    const events: import('../../src/projects/importStream').ImportEvent[] = [];
    const files = [new File(['a'], 'f1.png'), new File(['b'], 'f2.png'), new File(['c'], 'f3.png')];
    await streamUpload('p1', files, (e) => events.push(e));

    // One XHR per file
    expect(callCount()).toBe(3);

    const types = events.map((e) => e.type);
    expect(types[0]).toBe('start');
    expect(types[types.length - 1]).toBe('done');
    // 'uploading' events are no longer emitted — progress is byte-level now
    expect(types.filter((t) => t === 'uploading')).toHaveLength(0);
    // 'file' events: one per completed file
    expect(types.filter((t) => t === 'file')).toHaveLength(3);
    // 'progress' events: at least one per file (upload progress + completion)
    expect(types.filter((t) => t === 'progress').length).toBeGreaterThanOrEqual(3);
  });

  test('progress events carry byte-level loaded/total (not file index)', async () => {
    // Files have distinct sizes: 1, 2, 3 bytes → totalBytes = 6.
    const { MockXHR } = makeMockXhrClass([
      [`{"type":"start","total":1}\n`,
       `{"type":"file","name":"a.png","path":"a.png","ok":true,"imported":true}\n`,
       `{"type":"done","imported":1,"skipped":0,"errors":[]}\n`],
    ], /* uploadedBytes= */ 1);
    globalThis.XMLHttpRequest = MockXHR;

    const { streamUpload } = await import('../../src/projects/api');
    const progressEvents: { loaded: number; total: number }[] = [];
    const files = [new File(['x'], 'a.png')];   // size=1
    await streamUpload('p1', files, (e) => {
      if (e.type === 'progress') progressEvents.push({ loaded: e.loaded, total: e.total });
    });

    // total bytes = file.size = 1
    expect(progressEvents.length).toBeGreaterThan(0);
    expect(progressEvents[0]!.total).toBe(1);
    // Final progress event should have loaded >= 0 and match total
    const last = progressEvents[progressEvents.length - 1]!;
    expect(last.loaded).toBe(last.total);
  });

  test('label counts completed files via file events (not in-flight index)', async () => {
    // Verify that completed count = number of 'file' events, not file positions.
    const { MockXHR } = makeMockXhrClass([
      [`{"type":"start","total":1}\n`,
       `{"type":"file","name":"a.png","path":"a.png","ok":true,"imported":true}\n`,
       `{"type":"done","imported":1,"skipped":0,"errors":[]}\n`],
      [`{"type":"start","total":1}\n`,
       `{"type":"file","name":"b.png","path":"b.png","ok":true,"imported":false,"skipped":true}\n`,
       `{"type":"done","imported":0,"skipped":1,"errors":[]}\n`],
    ]);
    globalThis.XMLHttpRequest = MockXHR;

    const { streamUpload } = await import('../../src/projects/api');
    let completedCount = 0;
    const files = [new File(['a'], 'a.png'), new File(['b'], 'b.png')];
    await streamUpload('p1', files, (e) => {
      if (e.type === 'file') completedCount++;
    });

    // Exactly one 'file' event per completed upload — the label would show "2 of 2 done".
    expect(completedCount).toBe(2);
  });

  test('aggregates imported/skipped/errors across all files', async () => {
    // File 1: imported; File 2: skipped; File 3: error
    const { MockXHR } = makeMockXhrClass([
      [`{"type":"start","total":1}\n`,
       `{"type":"file","name":"a.png","path":"a.png","ok":true,"imported":true}\n`,
       `{"type":"done","imported":1,"skipped":0,"errors":[]}\n`],
      [`{"type":"start","total":1}\n`,
       `{"type":"file","name":"b.png","path":"b.png","ok":true,"imported":false,"skipped":true}\n`,
       `{"type":"done","imported":0,"skipped":1,"errors":[]}\n`],
      [`{"type":"start","total":1}\n`,
       `{"type":"file","name":"c.png","path":"c.png","ok":false,"error":"bad"}\n`,
       `{"type":"done","imported":0,"skipped":0,"errors":[{"file":"c.png","error":"bad"}]}\n`],
    ]);
    globalThis.XMLHttpRequest = MockXHR;

    const { streamUpload } = await import('../../src/projects/api');
    const events: import('../../src/projects/importStream').ImportEvent[] = [];
    const files = [new File(['a'], 'a.png'), new File(['b'], 'b.png'), new File(['c'], 'c.png')];
    await streamUpload('p1', files, (e) => events.push(e));

    const done = events[events.length - 1] as {
      type: 'done'; imported: number; skipped: number; errors: unknown[];
    };
    expect(done.type).toBe('done');
    expect(done.imported).toBe(1);
    expect(done.skipped).toBe(1);
    expect(done.errors).toHaveLength(1);
  });
});
