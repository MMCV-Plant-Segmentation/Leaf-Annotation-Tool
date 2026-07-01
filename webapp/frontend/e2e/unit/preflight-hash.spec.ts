/**
 * Unit tests for the pre-flight upload-dedup client (hashFile, probeHashes,
 * uploadWithPreflight). Verifies the browser hash reproduces the server's
 * sha256(bytes).hexdigest()[:24] byte-for-byte, that the probe subset is parsed, and
 * that only the missing files hit the network (already-present ones are reported, not sent).
 */
import { test, expect } from '@playwright/test';

const _origFetch = globalThis.fetch;
const _origXHR = globalThis.XMLHttpRequest;
test.afterEach(() => {
  globalThis.fetch = _origFetch;
  globalThis.XMLHttpRequest = _origXHR;
});

/** Minimal XHR mock: replies one NDJSON success group per send; counts sends. */
function makeMockXhr(): { MockXHR: typeof XMLHttpRequest; callCount: () => number } {
  let calls = 0;
  class MockXHR {
    upload = { onprogress: null as unknown, onload: null as (() => void) | null };
    onprogress: (() => void) | null = null;
    onloadend: (() => void) | null = null;
    status = 200;
    responseText = '';
    open(): void { /* noop */ }
    send(): void {
      calls++;
      Promise.resolve().then(() => {
        if (this.upload.onload) this.upload.onload();
        this.responseText =
          '{"type":"start","total":1}\n'
          + '{"type":"file","name":"x","path":"x","ok":true,"imported":true}\n'
          + '{"type":"done","imported":1,"skipped":0,"errors":[]}\n';
        if (this.onprogress) this.onprogress();
        if (this.onloadend) this.onloadend();
      });
    }
  }
  return { MockXHR: MockXHR as unknown as typeof XMLHttpRequest, callCount: () => calls };
}

test.describe('hashFile', () => {
  test('reproduces the server scheme sha256(bytes).hexdigest()[:24]', async () => {
    const { hashFile } = await import('../../src/projects/preflightHash');
    // Known vector: sha256("the quick brown fox").hexdigest()[:24] (matches backend P1).
    const h = await hashFile(new File(['the quick brown fox'], 'x.png'));
    expect(h).toBe('9ecb36561341d18eb65484e8');
    expect(h).toHaveLength(24);
  });
});

test.describe('probeHashes', () => {
  test('parses the have subset into a Set', async () => {
    globalThis.fetch = (async () => ({
      ok: true, status: 200, json: async () => ({ have: ['aaa', 'bbb'] }),
    })) as unknown as typeof fetch;
    const { probeHashes } = await import('../../src/projects/preflightHash');
    const have = await probeHashes('p1', ['aaa', 'bbb', 'ccc']);
    expect(have.has('aaa')).toBe(true);
    expect(have.has('ccc')).toBe(false);
  });

  test('throws on a non-ok response', async () => {
    globalThis.fetch = (async () => ({
      ok: false, status: 403, json: async () => ({ error: 'forbidden' }),
    })) as unknown as typeof fetch;
    const { probeHashes } = await import('../../src/projects/preflightHash');
    await expect(probeHashes('p1', ['aaa'])).rejects.toThrow('forbidden');
  });
});

test.describe('uploadWithPreflight', () => {
  test('all files already present → 0 uploads, all reported skipped', async () => {
    const { hashFile, uploadWithPreflight } = await import('../../src/projects/preflightHash');
    const files = [new File(['aaa'], 'a.png'), new File(['bbb'], 'b.png')];
    const hashes = await Promise.all(files.map(hashFile));
    globalThis.fetch = (async () => ({
      ok: true, status: 200, json: async () => ({ have: hashes }),
    })) as unknown as typeof fetch;
    const { MockXHR, callCount } = makeMockXhr();
    globalThis.XMLHttpRequest = MockXHR;

    let skipped: File[] = [];
    const events: { type: string }[] = [];
    await uploadWithPreflight('p1', files, (e) => events.push(e), (p) => { skipped = p; });

    expect(callCount()).toBe(0);                    // nothing hit the network
    expect(skipped).toHaveLength(2);                // both reported already-present
    expect(events[events.length - 1]!.type).toBe('done');
  });

  test('mixed batch → uploads only the new files', async () => {
    const { hashFile, uploadWithPreflight } = await import('../../src/projects/preflightHash');
    const files = [new File(['aaa'], 'a.png'), new File(['bbb'], 'b.png')];
    const hashes = await Promise.all(files.map(hashFile));
    // Project already has only the FIRST file.
    globalThis.fetch = (async () => ({
      ok: true, status: 200, json: async () => ({ have: [hashes[0]] }),
    })) as unknown as typeof fetch;
    const { MockXHR, callCount } = makeMockXhr();
    globalThis.XMLHttpRequest = MockXHR;

    let skipped: File[] = [];
    await uploadWithPreflight('p1', files, () => {}, (p) => { skipped = p; });

    expect(callCount()).toBe(1);                    // exactly one (the new) file uploaded
    expect(skipped).toEqual([files[0]]);            // the present one reported, never sent
  });
});
