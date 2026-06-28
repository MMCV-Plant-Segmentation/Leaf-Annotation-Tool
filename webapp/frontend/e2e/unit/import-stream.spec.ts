/**
 * Unit tests for the streaming-import NDJSON client (streamImport).
 * Verifies it reassembles events across arbitrary chunk boundaries (a line split
 * across two reads must still parse) and surfaces every event in order.
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
