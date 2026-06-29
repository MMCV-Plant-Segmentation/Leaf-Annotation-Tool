/**
 * Tiling sub-route (`/projects/:id/tiling`): the Minimum Luminance Threshold (MLT) +
 * tile-size controls and a per-image preview carousel. Guarded — if no images yet, show
 * the lock. Clicking a preview opens an interactive zoom/pan lightbox with the tile SVG
 * overlay; clicking a tile zooms to it and highlights it. The Fit button (or clicking the
 * same tile again) deselects and resets. Saving shows a "Saved ✓" confirmation.
 */
import { type Component, createMemo, createResource, createSignal, Show } from 'solid-js';
import { useNavigate, useParams } from '@solidjs/router';
import {
  Root as PopoverRoot, Trigger as PopoverTrigger,
  Portal as PopoverPortal, Content as PopoverContent,
} from '@kobalte/core/popover';
import {
  projectsApi, imageUrls,
  type ProjectImage, type Rect, type TilePreview as TilePreviewData,
} from './api';
import { t } from '../i18n/catalog';
import Carousel from '../shared/Carousel';
import Lightbox from '../shared/Lightbox';
import TilePreview from './TilePreview';
import TileOverlaySvg from './TileOverlaySvg';
import * as styles from './ProjectTilingScreen.css';

type BoxState = { im: ProjectImage; preview: TilePreviewData };

/** Toggle-deselect helper: same tile by value → deselect; different → select. */
const sameTile = (a: Rect | null, b: Rect): boolean =>
  a !== null && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

const ProjectTilingScreen: Component = () => {
  const params = useParams();
  const nav = useNavigate();
  const id = () => params.id!;
  const [project, { mutate }] = createResource(id, (pid) => projectsApi.get(pid));

  const [localTh, setLocalTh] = createSignal<number | null>(null);
  const [localTs, setLocalTs] = createSignal<number | null>(null);
  const [saving, setSaving] = createSignal(false);
  const [saved, setSaved] = createSignal(false);
  const [box, setBox] = createSignal<BoxState | null>(null);
  const [selectedTile, setSelectedTile] = createSignal<Rect | null>(null);
  const closeBox = () => { setBox(null); setSelectedTile(null); };

  const threshold = createMemo(() => localTh() ?? project()?.black_threshold ?? 0);
  const tileSize = createMemo(() => localTs() ?? project()?.tile_size_px ?? 128);
  const hasBatch = () => (project()?.batches.length ?? 0) > 0;

  const save = async () => {
    setSaving(true); setSaved(false);
    try {
      if (!hasBatch() && localTs() !== null) await projectsApi.updateTileSize(id(), tileSize());
      const p = await projectsApi.update(id(), { black_threshold: threshold(), tiling_confirmed: true });
      mutate((prev) => prev && { ...prev, ...p });
      setLocalTh(null); setLocalTs(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Show when={project()} fallback={<div class={styles.wrap}>{t('common.loading')}</div>}>
      {(p) => (
        <div class={styles.wrap} data-screen="project">
          <div class={styles.header}>
            <button class={styles.back} onClick={() => nav(`/projects/${id()}`)}>
              {t('detail.backHub')}
            </button>
            <h2 class={styles.title}>{t('detail.tile.stepTitle')}</h2>
          </div>

          <Show when={p().images.length === 0}>
            <p class={styles.lock}>{t('detail.tile.lockedNoImages')}</p>
          </Show>

          <Show when={p().images.length > 0}>
            <div class={styles.controls}>
              <label class={styles.field}>
                <span class={styles.bgLabel} data-testid="mlt-label">
                  {t('detail.tile.mlt')}
                  <PopoverRoot>
                    <PopoverTrigger class={styles.tip} data-testid="mlt-info"
                      aria-label={t('detail.tile.backgroundTip')}>ⓘ</PopoverTrigger>
                    <PopoverPortal>
                      <PopoverContent class={styles.popover} data-testid="mlt-popover">
                        {t('detail.tile.backgroundTip')}
                      </PopoverContent>
                    </PopoverPortal>
                  </PopoverRoot>
                </span>
                <input type="range" min="0" max="255" value={threshold()}
                  data-testid="background-slider"
                  onInput={(e) => setLocalTh(Number(e.currentTarget.value))} />
                <span class={styles.value}>{t('detail.tile.backgroundValue', { value: threshold() })}</span>
              </label>
              <label class={styles.field}>
                <span>{t('detail.tile.sizeLabel')}</span>
                <input type="number" min="8" value={tileSize()} disabled={hasBatch()}
                  data-testid="tile-size-input"
                  onInput={(e) => setLocalTs(Number(e.currentTarget.value))} />
                <Show when={hasBatch()}>
                  <span class={styles.locked}>{t('detail.tile.sizeLocked')}</span>
                </Show>
              </label>
              <button class={styles.saveBtn} disabled={saving()} onClick={() => void save()}>
                {saving() ? t('common.saving') : t('detail.tile.saveDefault')}
              </button>
              <Show when={saved()}>
                <span class={styles.savedOk} data-testid="save-confirm">{t('detail.tile.saved')}</span>
              </Show>
            </div>

            <Carousel<ProjectImage>
              items={p().images}
              caption={(im) => im.source_path ?? im.source_name ?? ''}
              labelPrev={t('detail.tile.prev')}
              labelNext={t('detail.tile.next')}
            >
              {(im) => (
                <TilePreview projectId={id()} imageId={im.id}
                  threshold={threshold()} tileSize={tileSize()}
                  onEnlarge={(pv) => { setSelectedTile(null); setBox({ im, preview: pv }); }} />
              )}
            </Carousel>

            <Lightbox
              open={box() !== null}
              src={box() ? imageUrls.overview(box()!.im.id) : ''}
              caption={box()?.im.source_path ?? box()?.im.source_name ?? ''}
              naturalWidth={box()?.preview.imageWidth}
              naturalHeight={box()?.preview.imageHeight}
              zoomTarget={selectedTile()}
              onZoomReset={() => setSelectedTile(null)}
              overlay={box()
                ? <TileOverlaySvg testid="lightbox-tile-overlay"
                    imageWidth={box()!.preview.imageWidth}
                    imageHeight={box()!.preview.imageHeight}
                    tiles={box()!.preview.tiles}
                    selectedTile={selectedTile()}
                    onTileClick={(tile) =>
                      setSelectedTile((s) => sameTile(s, tile) ? null : tile)} />
                : undefined}
              onClose={closeBox}
            />
          </Show>
        </div>
      )}
    </Show>
  );
};

export default ProjectTilingScreen;
