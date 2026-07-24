/**
 * t93 — persist the annotator brush size across reloads (localStorage, not the URL).
 *
 * Pure load/save helpers in src/projects/brushSizePersist.ts; the mount-restore + save-on-change
 * wiring lives in CanvasScreen (a restored non-zero value suppresses the tile-derived default).
 * The unit runner has no DOM, so we install a tiny in-memory localStorage stub.
 */
import { test, expect } from '@playwright/test';

function installStorage(): Map<string, string> {
  const backing = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
    setItem: (k: string, v: string) => void backing.set(k, String(v)),
    removeItem: (k: string) => void backing.delete(k),
    clear: () => backing.clear(),
    key: () => null,
    get length() { return backing.size; },
  } as Storage;
  return backing;
}

test.describe('loadBrushSize / saveBrushSize', () => {
  test('round-trips a positive size (rounded to a whole pixel)', async () => {
    installStorage();
    const { loadBrushSize, saveBrushSize } = await import('../../src/projects/brushSizePersist');
    saveBrushSize(42.6);
    expect(loadBrushSize()).toBe(43);
  });

  test('returns null when nothing has been stored', async () => {
    installStorage();
    const { loadBrushSize } = await import('../../src/projects/brushSizePersist');
    expect(loadBrushSize()).toBeNull();
  });

  test('never persists the pre-default sentinel (0) or non-positive values', async () => {
    const backing = installStorage();
    const { loadBrushSize, saveBrushSize } = await import('../../src/projects/brushSizePersist');
    saveBrushSize(0);
    saveBrushSize(-5);
    expect(backing.size).toBe(0);
    expect(loadBrushSize()).toBeNull();
  });

  test('rejects a corrupt stored value → null (falls back to the default)', async () => {
    installStorage();
    localStorage.setItem('leaf.annotator.brushSize', 'not-a-number');
    const { loadBrushSize } = await import('../../src/projects/brushSizePersist');
    expect(loadBrushSize()).toBeNull();
  });

  test('is resilient when storage is unavailable (no throw)', async () => {
    // Simulate private-mode / disabled storage: accessing localStorage throws.
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new Error('storage disabled'); },
    });
    const { loadBrushSize, saveBrushSize } = await import('../../src/projects/brushSizePersist');
    expect(() => saveBrushSize(10)).not.toThrow();
    expect(loadBrushSize()).toBeNull();
  });
});
