import { type Component, createMemo, createResource, createSignal, For, Show } from 'solid-js';
import { useNavigate, useParams } from '@solidjs/router';
import { projectsApi, imageUrls, type ProjectImage, type TilePreview } from './api';
import { t } from '../i18n/catalog';
import ProjectProgressTable from './ProjectProgressTable';
import * as styles from './ProjectDetailScreen.css';

const ProjectDetailScreen: Component = () => {
  const params = useParams();
  const nav = useNavigate();
  const id = () => params.id!;

  const [project, { mutate, refetch }] = createResource(id, (pid: string) => projectsApi.get(pid));
  const reload = () => void refetch();

  // ── roster ──
  const [newByline, setNewByline] = createSignal('');
  const addAnnotator = async () => {
    const b = newByline().trim();
    if (!b) return;
    try { await projectsApi.addAnnotator(id(), b); setNewByline(''); reload(); }
    catch (e) { alert(e instanceof Error ? e.message : 'Failed'); }
  };

  // ── image import ──
  const [importPath, setImportPath] = createSignal('');
  const [importMsg, setImportMsg] = createSignal('');
  const [importing, setImporting] = createSignal(false);
  const doImport = async () => {
    setImportMsg(''); setImporting(true);
    try {
      const r = await projectsApi.importImages(id(), importPath().trim());
      setImportMsg(`Imported ${r.imported}, skipped ${r.skipped}${r.errors.length ? `, ${r.errors.length} errors` : ''}`);
      reload();
    } catch (e) { setImportMsg(e instanceof Error ? e.message : 'Failed'); }
    finally { setImporting(false); }
  };

  // ── tile preview ──
  const [selImage, setSelImage] = createSignal<ProjectImage | null>(null);
  const [previewThreshold, setPreviewThreshold] = createSignal<number | null>(null);
  const threshold = createMemo(() => previewThreshold() ?? project()?.black_threshold ?? 40);
  const [preview] = createResource(
    () => { const im = selImage(); return im ? { im, t: threshold() } : null; },
    (k) => projectsApi.previewTiles(id(), k.im.id, { black_threshold: k.t }),
  );
  const saveThreshold = async () => {
    await projectsApi.update(id(), { black_threshold: threshold() });
    mutate((p) => p && { ...p, black_threshold: threshold() });
  };

  // ── batches ──
  const [batchSize, setBatchSize] = createSignal(5);
  const [openAs, setOpenAs] = createSignal('');
  const createBatch = async () => {
    try { await projectsApi.createBatch(id(), batchSize()); reload(); }
    catch (e) { alert(e instanceof Error ? e.message : 'Failed'); }
  };
  const openCanvas = (batchId: string) => {
    const as = openAs() || project()?.annotators[0]?.byline;
    if (!as) { alert(t('detail.annotator.required')); return; }
    nav(`/projects/${id()}/batches/${batchId}?as=${encodeURIComponent(as)}`);
  };

  return (
    <Show when={project()} fallback={<div class={styles.wrap}>{t('common.loading')}</div>}>
      {(p) => (
        <div class={styles.wrap}>
          <div class={styles.header}>
            <button class={styles.back} onClick={() => nav('/projects')}>{t('detail.back')}</button>
            <h2 class={styles.title}>{p().name}</h2>
            <span class={styles.sub}>{t('detail.tile.sub', { px: p().tile_size_px, threshold: p().black_threshold })}</span>
          </div>

          <div class={styles.grid}>
            {/* Roster */}
            <section class={styles.panel}>
              <h3>{t('detail.annotators')}</h3>
              <div class={styles.addRow}>
                <input type="text" placeholder={t('detail.annotator.placeholder')} value={newByline()}
                  onInput={(e) => setNewByline(e.currentTarget.value)} />
                <button onClick={() => void addAnnotator()}>{t('detail.annotator.add')}</button>
              </div>
              <ul class={styles.plainList}>
                <For each={p().annotators} fallback={<li class={styles.muted}>{t('detail.annotator.none')}</li>}>
                  {(a) => (
                    <li>
                      <span>{a.byline}</span>
                      <button class={styles.linkDanger}
                        onClick={async () => { await projectsApi.removeAnnotator(id(), a.id); reload(); }}>
                        {t('detail.annotator.remove')}
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </section>

            {/* Images + import */}
            <section class={styles.panel}>
              <h3>{t('detail.images', { count: p().images.length })}</h3>
              <div class={styles.addRow}>
                <input type="text" placeholder={t('detail.images.importPlaceholder')} value={importPath()}
                  onInput={(e) => setImportPath(e.currentTarget.value)} />
                <button disabled={importing()} onClick={() => void doImport()}>
                  {importing() ? t('detail.images.importing') : t('detail.images.import')}
                </button>
              </div>
              <div class={styles.muted}>{importMsg()}</div>
              <ul class={styles.thumbGrid}>
                <For each={p().images}>
                  {(im) => (
                    <li class={`${styles.thumb} ${selImage()?.id === im.id ? styles.thumbSel : ''}`}
                      onClick={() => setSelImage(im)}>
                      <img src={imageUrls.overview(im.id)} alt={im.source_name ?? ''} loading="lazy" />
                      <span>{im.source_name}</span>
                    </li>
                  )}
                </For>
              </ul>
            </section>
          </div>

          {/* Tile preview */}
          <Show when={selImage()}>
            <section class={styles.panel}>
              <h3>{t('detail.tile.preview', { name: selImage()!.source_name ?? '' })}</h3>
              <div class={styles.sliderRow}>
                <label>{t('detail.tile.threshold', { value: threshold() })}</label>
                <input type="range" min="0" max="255" value={threshold()}
                  onInput={(e) => setPreviewThreshold(Number(e.currentTarget.value))} />
                <button onClick={() => void saveThreshold()}>{t('detail.tile.saveDefault')}</button>
              </div>
              <Show when={preview()} fallback={<div class={styles.muted}>{t('detail.tile.computing')}</div>}>
                <TilePreviewSvg imageId={selImage()!.id} preview={preview()!} />
                <div class={styles.muted}>{t('detail.tile.surviveCount', { count: preview()!.tiles.length })}</div>
              </Show>
            </section>
          </Show>

          {/* Batches */}
          <section class={styles.panel}>
            <h3>{t('detail.batches')}</h3>
            <div class={styles.addRow}>
              <label>{t('detail.batch.sizeLabel')} <input type="number" min="1" value={batchSize()}
                onInput={(e) => setBatchSize(Number(e.currentTarget.value))} /></label>
              <button onClick={() => void createBatch()}>{t('detail.batch.create')}</button>
              <Show when={p().annotators.length > 0}>
                <label class={styles.openAs}>{t('detail.batch.openAs')}
                  <select onChange={(e) => setOpenAs(e.currentTarget.value)}>
                    <For each={p().annotators}>{(a) => <option value={a.byline}>{a.byline}</option>}</For>
                  </select>
                </label>
              </Show>
            </div>
            <ul class={styles.plainList}>
              <For each={p().batches} fallback={<li class={styles.muted}>{t('detail.batch.none')}</li>}>
                {(b) => (
                  <li>
                    <span>{t('detail.batch.info', { seq: b.seq, count: b.tileCount, status: b.status })}</span>
                    <button class={styles.link} onClick={() => openCanvas(b.id)}>{t('detail.batch.open')}</button>
                  </li>
                )}
              </For>
            </ul>
          </section>

          {/* Progress */}
          <ProjectProgressTable progress={p().progress} />
        </div>
      )}
    </Show>
  );
};

// Overview image with the surviving tiles overlaid as an SVG grid.
const TilePreviewSvg: Component<{ imageId: string; preview: TilePreview }> = (props) => (
  <div class={styles.previewBox}>
    <img src={imageUrls.overview(props.imageId)} alt="" />
    <svg class={styles.previewSvg} viewBox={`0 0 ${props.preview.imageWidth} ${props.preview.imageHeight}`}
      preserveAspectRatio="xMidYMid meet">
      <For each={props.preview.tiles}>
        {(tile) => <rect x={tile.x} y={tile.y} width={tile.w} height={tile.h}
          fill="rgba(37,99,235,0.18)" stroke="#2563eb" stroke-width="2" vector-effect="non-scaling-stroke" />}
      </For>
    </svg>
  </div>
);

export default ProjectDetailScreen;
