/**
 * Tiling sub-route (`/projects/:id/tiling`): MLT + tile-size controls and a per-image
 * preview carousel. Guarded — if no images yet, show the lock. Clicking a preview opens
 * a lightbox with the tile SVG overlay; clicking a tile zooms to it. The Fit button (or
 * clicking the same tile again) deselects. Saving shows "Saved ✓". Threshold/tile-size
 * readouts are live; the preview fetch is debounced (~275ms) to reduce API calls.
 * Unsaved changes guard: warns via confirm() before router nav and beforeunload.
 */
import { type Component, createMemo, createResource, createSignal, ErrorBoundary, onMount, onCleanup, Show } from 'solid-js';
import { debounce } from '@solid-primitives/scheduled';
import { useNavigate, useParams, useBeforeLeave } from '@solidjs/router';
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
import ProjectNotFound from './ProjectNotFound';
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
  // Debounced mirrors of the two controls — drive the /preview fetch on settle.
  const [debTh, setDebTh] = createSignal<number | null>(null);
  const [debTs, setDebTs] = createSignal<number | null>(null);
  const pushDebTh = debounce((v: number) => setDebTh(v), 275);
  const pushDebTs = debounce((v: number) => setDebTs(v), 275);
  const [saving, setSaving] = createSignal(false);
  const [saved, setSaved] = createSignal(false);
  const [box, setBox] = createSignal<BoxState | null>(null);
  const [selectedTile, setSelectedTile] = createSignal<Rect | null>(null);
  const closeBox = () => { setBox(null); setSelectedTile(null); };

  // dirty = user changed threshold or tile-size without saving yet
  const dirty = createMemo(() => localTh() !== null || localTs() !== null);
  // Guard client-side route changes while dirty
  useBeforeLeave((e) => {
    if (!dirty()) return;
    e.preventDefault();
    if (confirm(t('tiling.unsavedWarn'))) e.retry(true);
  });
  onMount(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (!dirty()) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    onCleanup(() => window.removeEventListener('beforeunload', handler));
  });

  // Safe project data — never throws; returns undefined in loading/error state.
  // project() throws in SolidJS error state, which would propagate errors past the
  // <ErrorBoundary> if called inside top-level memos. Wrap in try-catch so tracking
  // is set up (read() calls track() before throwing) but the error is silenced here.
  const safeData = createMemo(() => { try { return project(); } catch { return undefined; } });
  // Live values — drive the on-screen readout/input every onInput (responsive feel).
  const threshold = createMemo(() => localTh() ?? safeData()?.black_threshold ?? 0);
  const tileSize = createMemo(() => localTs() ?? safeData()?.tile_size_px ?? 128);
  // Debounced values — drive the preview fetch.
  const previewThreshold = createMemo(() => debTh() ?? safeData()?.black_threshold ?? 0);
  const previewTileSize = createMemo(() => debTs() ?? safeData()?.tile_size_px ?? 128);
  const onThInput = (v: number) => { setLocalTh(v); pushDebTh(v); };
  const onTsInput = (v: number) => { setLocalTs(v); pushDebTs(v); };
  const hasBatch = () => (project()?.batches.length ?? 0) > 0;

  const save = async () => {
    setSaving(true); setSaved(false);
    try {
      if (!hasBatch() && localTs() !== null) await projectsApi.updateTileSize(id(), tileSize());
      const p = await projectsApi.update(id(), { black_threshold: threshold(), tiling_confirmed: true });
      mutate((prev) => prev && { ...prev, ...p });
      setLocalTh(null); setLocalTs(null);
      setDebTh(null); setDebTs(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ErrorBoundary fallback={<ProjectNotFound />}>
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
                    onInput={(e) => onThInput(Number(e.currentTarget.value))} />
                  <span class={styles.value}>{t('detail.tile.backgroundValue', { value: threshold() })}</span>
                </label>
                <label class={styles.field}>
                  <span>{t('detail.tile.sizeLabel')}</span>
                  <input type="number" min="8" value={tileSize()} disabled={hasBatch()}
                    data-testid="tile-size-input"
                    onInput={(e) => onTsInput(Number(e.currentTarget.value))} />
                  <Show when={hasBatch()}>
                    <span class={styles.locked}>{t('detail.tile.sizeLocked')}</span>
                  </Show>
                </label>
                <button class={styles.saveBtn} data-testid="tiling-save-btn"
                  disabled={saving()} onClick={() => void save()}>
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
                    threshold={previewThreshold()} tileSize={previewTileSize()}
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
    </ErrorBoundary>
  );
};

export default ProjectTilingScreen;
