/**
 * MERGE Phase 1: the read-only blind pooled viewer. Fetches the batch's tiles/images
 * (no per-annotator data) plus every non-deleted annotation from EVERY annotator that
 * intersects the batch, and renders them ALL identically — one colour, outline-only —
 * so a merger can't tell whose mark is whose. Reuses CanvasScreen's viewport (pan/zoom
 * via createCanvasInteraction) and stroke rendering (AnnotationShape's `blind` mode) —
 * no drawing tools, no selection, no tile-complete toggle. Navigation is TILE-by-tile
 * (flattened across every image in the batch, in server order) — each step re-fits the
 * viewport to that tile (padded for context), switching image underneath when the next
 * tile belongs to a different one. Grouping/agreement/conflict threads are later
 * phases; this screen is just the pooled view.
 */
import { type Component, createEffect, createMemo, createResource, createSignal, For, Show, on } from 'solid-js';
import { useNavigate, useParams } from '@solidjs/router';
import { projectsApi, imageUrls, type CanvasImage, type CanvasTile } from './api';
import { t } from '../i18n/catalog';
import { type ViewBox, AnnotationShape, CanvasTiles } from './canvasShapes';
import { createCanvasInteraction } from './canvasInteraction';
import { createImageDecodeGate } from './imageDecodeGate';
import * as styles from './CanvasScreen.css';
import * as mstyles from './MergeCanvasScreen.css';

// Every pooled mark renders in this ONE colour regardless of who drew it — the whole
// point of blind merge mode. Data-viz colour, so it's inline here per FE convention
// rather than a theme token (it isn't chrome, it's the anonymised mark paint).
const BLIND_COLOR = '#0ea5e9';

type FlatTile = CanvasTile & { imageId: string };

const MergeCanvasScreen: Component = () => {
  const params = useParams();
  const nav = useNavigate();
  const batchId = () => params.batchId;

  const [batch] = createResource(batchId, (id: string) => projectsApi.mergeBatch(id));
  const [pooled] = createResource(batchId, (id: string) => projectsApi.mergeAnnotations(id));

  // Flatten every image's tiles into one ordered list — the merge-mode nav unit is a
  // TILE, not a whole image (an image can hold many tiles).
  const allTiles = createMemo<FlatTile[]>(() =>
    (batch()?.images ?? []).flatMap((im) => im.tiles.map((tl) => ({ ...tl, imageId: im.imageId }))));

  const [tileIdx, setTileIdx] = createSignal(0);
  const tileCount = () => allTiles().length;
  const currentTile = createMemo(() => allTiles()[tileIdx()]);
  const currentImage = createMemo<CanvasImage | undefined>(() =>
    batch()?.images.find((im) => im.imageId === currentTile()?.imageId));

  const imageId = createMemo(() => currentImage()?.imageId);
  const imgLoaded = createImageDecodeGate(imageId);

  const [vb, setVb] = createSignal<ViewBox>({ x: 0, y: 0, w: 100, h: 100 });
  let svgRef: SVGSVGElement | undefined;

  // Fit the viewport to the current tile, padded ~15% per side for surrounding context.
  const fitTile = () => {
    const t = currentTile();
    if (!t) return;
    const pad = Math.max(t.w, t.h) * 0.15;
    setVb({ x: t.x - pad, y: t.y - pad, w: t.w + pad * 2, h: t.h + pad * 2 });
  };
  createEffect(on(currentTile, () => { if (currentTile()) fitTile(); }));

  // Read-only: pan/zoom only. `tool` is pinned to 'pan' and `commit` is a no-op, so
  // there's no path to a write even though createCanvasInteraction is shared plumbing.
  const [draft, setDraft] = createSignal<number[][]>([]);
  const interaction = createCanvasInteraction({
    getSvg: () => svgRef, vb, setVb, tool: () => 'pan', draft, setDraft,
    brushSize: () => 0, setBrushSize: () => {}, maxBrushSize: () => 1,
    commit: () => {},
  });

  const annotationsForImage = createMemo(() => {
    const im = currentImage();
    if (!im) return [];
    return (pooled()?.annotations ?? []).filter((a) => a.imageId === im.imageId);
  });

  return (
    <div class={styles.wrap} data-screen="merge-canvas">
      <div class={styles.toolbar} data-testid="merge-toolbar">
        <button class={styles.back} onClick={() => nav(-1)}>{t('canvas.back')}</button>
        <span class={mstyles.blindBadge} data-testid="merge-blind-badge">{t('mergeCanvas.blindLabel')}</span>
        <span class={styles.sep} />
        <button class={styles.tool} disabled={tileIdx() === 0}
          data-testid="merge-tile-prev"
          onClick={() => setTileIdx((i) => i - 1)}>{t('canvas.imgPrev')}</button>
        <span class={styles.who} data-testid="merge-tile-counter">
          {t('mergeCanvas.tileCounter', { i: tileIdx() + 1, n: tileCount() })}
        </span>
        <button class={styles.tool} disabled={tileIdx() >= tileCount() - 1}
          data-testid="merge-tile-next"
          onClick={() => setTileIdx((i) => i + 1)}>{t('canvas.imgNext')}</button>
        <span class={styles.sep} />
        <button class={styles.tool} onClick={fitTile}>{t('canvas.fit')}</button>
      </div>

      <Show when={currentImage()} fallback={<div class={styles.stage}>{t('common.loading')}</div>}>
        {(im) => (
          <div class={styles.stage}>
            <svg ref={svgRef} class={styles.svg}
              viewBox={`${vb().x} ${vb().y} ${vb().w} ${vb().h}`}
              preserveAspectRatio="xMidYMid meet"
              onWheel={interaction.onWheel}
              onPointerDown={interaction.onPointerDown}
              onPointerMove={interaction.onPointerMove}
              onPointerUp={interaction.onPointerUp}
              onPointerLeave={interaction.onPointerLeave}
            >
              <image href={imageUrls.overview(im().imageId)} x="0" y="0"
                width={im().width} height={im().height} />
              <CanvasTiles tiles={im().tiles} checkClass={styles.check} />
              <Show when={imgLoaded()}>
                <For each={annotationsForImage()}>
                  {(a) => <AnnotationShape ann={a} color={BLIND_COLOR} blind />}
                </For>
              </Show>
            </svg>
          </div>
        )}
      </Show>
    </div>
  );
};

export default MergeCanvasScreen;
