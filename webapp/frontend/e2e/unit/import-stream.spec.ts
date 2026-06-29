/**
 * Unit tests for the streaming-import NDJSON client (streamImport, streamUpload).
 * Verifies it reassembles events across arbitrary chunk boundaries (a line split
 * across two reads must still parse) and surfaces every event in order.
 * Also verifies streamUpload posts one file at a time and aggregates counts.
 */
import { test, expect } from '@playwright/test';

const _origFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = _origFetch; });

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

// ── streamUpload (sequential) ─────────────────────────────────────────────────

test.describe('streamUpload (sequential per-file)', () => {
  test('posts one file per request and emits start/uploading/file/done in order', async () => {
    let callCount = 0;
    globalThis.fetch = (async (_url: unknown) => {
      const n = ++callCount;
      return streamResponse([
        `{"type":"start","total":1}\n`,
        `{"type":"file","name":"f${n}.png","path":"f${n}.png","ok":true,"imported":true}\n`,
        `{"type":"done","imported":1,"skipped":0,"errors":[]}\n`,
      ]);
    }) as typeof fetch;

    const { streamUpload } = await import('../../src/projects/api');
    const events: import('../../src/projects/importStream').ImportEvent[] = [];
    const files = [new File(['a'], 'f1.png'), new File(['b'], 'f2.png'), new File(['c'], 'f3.png')];
    await streamUpload('p1', files, (e) => events.push(e));

    // Three separate fetch calls (one per file).
    expect(callCount).toBe(3);

    const types = events.map((e) => e.type);
    // start once, uploading×3, file×3, done once
    expect(types[0]).toBe('start');
    expect(types[types.length - 1]).toBe('done');
    expect(types.filter((t) => t === 'uploading')).toHaveLength(3);
    expect(types.filter((t) => t === 'file')).toHaveLength(3);
    // No per-file 'start' or per-file 'done' events forwarded
    const uploadingEvs = events.filter((e) => e.type === 'uploading') as
      { type: 'uploading'; index: number; total: number }[];
    expect(uploadingEvs.map((e) => e.index)).toEqual([1, 2, 3]);
    expect(uploadingEvs[0].total).toBe(3);
  });

  test('aggregates imported/skipped/errors across all files', async () => {
    // File 1: imported; File 2: skipped; File 3: error
    const responses = [
      ['{"type":"start","total":1}\n',
       '{"type":"file","name":"a.png","path":"a.png","ok":true,"imported":true}\n',
       '{"type":"done","imported":1,"skipped":0,"errors":[]}\n'],
      ['{"type":"start","total":1}\n',
       '{"type":"file","name":"b.png","path":"b.png","ok":true,"imported":false,"skipped":true}\n',
       '{"type":"done","imported":0,"skipped":1,"errors":[]}\n'],
      ['{"type":"start","total":1}\n',
       '{"type":"file","name":"c.png","path":"c.png","ok":false,"error":"bad"}\n',
       '{"type":"done","imported":0,"skipped":0,"errors":[{"file":"c.png","error":"bad"}]}\n'],
    ];
    let idx = 0;
    globalThis.fetch = (async () => streamResponse(responses[idx++]!)) as typeof fetch;

    const { streamUpload } = await import('../../src/projects/api');
    const events: import('../../src/projects/importStream').ImportEvent[] = [];
    const files = [new File(['a'], 'a.png'), new File(['b'], 'b.png'), new File(['c'], 'c.png')];
    await streamUpload('p1', files, (e) => events.push(e));

    const done = events[events.length - 1] as { type: 'done'; imported: number; skipped: number; errors: unknown[] };
    expect(done.type).toBe('done');
    expect(done.imported).toBe(1);
    expect(done.skipped).toBe(1);
    expect(done.errors).toHaveLength(1);
  });
});
