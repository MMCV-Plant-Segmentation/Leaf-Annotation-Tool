// t93 — reactive wiring for brush-size persistence (kept out of the pure brushSizePersist.ts,
// mirroring the viewportUrl.ts / viewportUrlSync.ts split). Restores the last-used size on
// creation and saves every change; a restored non-zero size suppresses CanvasScreen's
// tile-derived default (which only fires while the size is still the 0 sentinel).
import { type Accessor, type Setter, createEffect, createSignal, on } from 'solid-js';
import { loadBrushSize, saveBrushSize } from './brushSizePersist';

export function createPersistedBrushSize(): [Accessor<number>, Setter<number>] {
  const [size, setSize] = createSignal(loadBrushSize() ?? 0);
  createEffect(on(size, (n) => saveBrushSize(n)));
  return [size, setSize];
}
