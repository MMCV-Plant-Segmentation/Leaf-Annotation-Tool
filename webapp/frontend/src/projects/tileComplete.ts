/**
 * Tile completion toggle, extracted from CanvasScreen (keeps that file ≤200 lines).
 *
 * Toggles a tile between completed/assigned on the server, optimistically updating the
 * canvas ONLY on success and SURFACING any failure via `error` instead of swallowing the
 * rejection — a silently-dropped error here is why "mark complete" could appear to do
 * nothing (the reported "can't complete tiles on Mac"): the PATCH failed with no feedback.
 */
import { createSignal } from 'solid-js';
import type { Setter } from 'solid-js';
import { projectsApi, type BatchCanvas, type CanvasTile } from './api';
import { t } from '../i18n/catalog';

export function createTileToggle(imgIdx: () => number, setCanvas: Setter<BatchCanvas | undefined>) {
  const [error, setError] = createSignal('');
  const toggle = async (tile: CanvasTile) => {
    if (!tile.annotatorTileId) return;
    const next = tile.state === 'completed' ? 'assigned' : 'completed';
    try {
      await projectsApi.setTileState(tile.annotatorTileId, next);
      setCanvas((c) => c && ({
        ...c,
        images: c.images.map((im, i) => i === imgIdx()
          ? { ...im, tiles: im.tiles.map((tl) => tl.tileId === tile.tileId ? { ...tl, state: next } : tl) } : im),
      }));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : t('canvas.tileError'));
    }
  };
  return { toggle, error };
}
