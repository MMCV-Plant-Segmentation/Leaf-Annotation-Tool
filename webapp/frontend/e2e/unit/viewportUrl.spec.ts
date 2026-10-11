/**
 * t92 — persist + share the canvas viewport in the URL.
 *
 * The annotator canvas viewBox (pan/zoom) is encoded into a URL query param so a reload
 * restores it and the link is shareable. Pure encode/decode helpers in src/projects/
 * viewportUrl.ts; the mount-restore + debounced URL-write wiring lives in a small sync
 * module driven from CanvasScreen (covered by the existing canvas specs / build).
 */
import { test, expect } from '@playwright/test';

test.describe('encodeViewport / decodeViewport', () => {
  test('round-trips a viewBox (to within the encoded precision)', async () => {
    const { encodeViewport, decodeViewport } = await import('../../src/projects/viewportUrl');
    const vb = { x: 123.4, y: 56.7, w: 800.2, h: 600.9 };
    const back = decodeViewport(encodeViewport(vb));
    expect(back).not.toBeNull();
    expect(back!.x).toBeCloseTo(vb.x, 0);
    expect(back!.y).toBeCloseTo(vb.y, 0);
    expect(back!.w).toBeCloseTo(vb.w, 0);
    expect(back!.h).toBeCloseTo(vb.h, 0);
  });

  test('encodes to a compact string (no spaces, URL-safe)', async () => {
    const { encodeViewport } = await import('../../src/projects/viewportUrl');
    const s = encodeViewport({ x: 10, y: 20, w: 300, h: 400 });
    expect(typeof s).toBe('string');
    expect(s).not.toMatch(/\s/);
    expect(s).toBe(encodeURIComponent(s));   // safe to drop straight into a query value
  });

  test('decode rejects malformed / partial / non-positive input → null', async () => {
    const { decodeViewport } = await import('../../src/projects/viewportUrl');
    expect(decodeViewport('')).toBeNull();
    expect(decodeViewport('1,2,3')).toBeNull();          // too few components
    expect(decodeViewport('a,b,c,d')).toBeNull();        // not numbers
    expect(decodeViewport('0,0,0,100')).toBeNull();      // zero width
    expect(decodeViewport('0,0,100,-5')).toBeNull();     // negative height
    expect(decodeViewport('0,0,100,100,7')).toBeNull();  // too many components
  });

  test('decode(encode(vb)) preserves a positive, non-degenerate viewBox', async () => {
    const { encodeViewport, decodeViewport } = await import('../../src/projects/viewportUrl');
    const back = decodeViewport(encodeViewport({ x: 0, y: 0, w: 128, h: 128 }));
    expect(back).not.toBeNull();
    expect(back!.w).toBeGreaterThan(0);
    expect(back!.h).toBeGreaterThan(0);
  });
});
