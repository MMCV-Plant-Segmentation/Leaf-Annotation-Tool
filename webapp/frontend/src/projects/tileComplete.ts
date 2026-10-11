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

export function createTileToggle(imgIdx: () => number, setCanvas: Setter<BatchCanvas | undefined>,
                                 annotator: () => string) {
  const [error, setError] = createSignal('');
  const toggle = async (tile: CanvasTile) => {
    // t126: no pre-provisioned annotatorTileId guard — completion is lazy, keyed on the
    // batch tile + the current annotator; the row is minted on the first mark (fixes t112).
    const next = tile.state === 'completed' ? 'assigned' : 'completed';
    try {
      const r = await projectsApi.setTileState(tile.batchTileId, annotator(), next);
      setCanvas((c) => c && ({
        ...c,
        images: c.images.map((im, i) => i === imgIdx()
          ? { ...im, tiles: im.tiles.map((tl) => tl.tileId === tile.tileId
              ? { ...tl, state: next, annotatorTileId: r.annotatorTileId } : tl) } : im),
      }));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : t('canvas.tileError'));
    }
  };
  return { toggle, error };
}
