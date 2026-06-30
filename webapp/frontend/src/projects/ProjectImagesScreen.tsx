/**
 * Images sub-route (`/projects/:id/images`): browser upload (primary) with per-file
 * streaming progress, plus a de-emphasized server-path import for dev/admin use,
 * and a clamped lazy-loading preview of the imported images.
 */
import { type Component, createResource, createSignal, ErrorBoundary, Show } from 'solid-js';
import { useNavigate, useParams } from '@solidjs/router';
import { projectsApi, imageUrls, streamImport, streamUpload, type ImportEvent } from './api';
import { currentUser } from '../auth';
import { t } from '../i18n/catalog';
import LazyImageGrid, { type LazyImageItem } from '../shared/LazyImageGrid';
import Lightbox from '../shared/Lightbox';
import ProjectNotFound from './ProjectNotFound';
import * as styles from './ProjectImagesScreen.css';

const IMAGE_ACCEPT = '.png,.jpg,.jpeg,.tif,.tiff';

const ProjectImagesScreen: Component = () => {
  const params = useParams();
  const nav = useNavigate();
  const id = () => params.id!;
  const [project, { refetch }] = createResource(id, (pid) => projectsApi.get(pid));

  // Shared progress state (used by both upload and path-import flows)
  const [busy, setBusy] = createSignal(false);
  const [total, setTotal] = createSignal(0);
  const [done, setDone] = createSignal(0);
  const [errs, setErrs] = createSignal(0);
  const [summary, setSummary] = createSignal('');
  const [boxId, setBoxId] = createSignal<string | null>(null);

  const [selectedFiles, setSelectedFiles] = createSignal<File[]>([]);
  const [dragging, setDragging] = createSignal(false);
  const [byteLoaded, setByteLoaded] = createSignal(0);
  const [byteTotal, setByteTotal] = createSignal(0);
  const [path, setPath] = createSignal('');

  let fileInputRef!: HTMLInputElement;

  const boxImage = () => project()?.images.find((im) => im.id === boxId()) ?? null;
  // Use byte fraction when available (upload flow); fall back to file count (path-import flow).
  const pct = () => byteTotal() > 0
    ? Math.round((byteLoaded() / byteTotal()) * 100)
    : total() > 0 ? Math.round((done() / total()) * 100) : 0;

  const onEvent = (ev: ImportEvent) => {
    if (ev.type === 'start') { setTotal(ev.total); setDone(0); setErrs(0); }
    else if (ev.type === 'progress') { setByteLoaded(ev.loaded); setByteTotal(ev.total); }
    else if (ev.type === 'file') { setDone((n) => n + 1); if (!ev.ok) setErrs((n) => n + 1); }
    else if (ev.type === 'done') {
      setSummary(t('detail.images.importDone', {
        imported: ev.imported, skipped: ev.skipped, errors: ev.errors.length,
      }));
    }
  };

  const doUpload = async () => {
    const files = selectedFiles();
    if (!files.length || busy()) return;
    setBusy(true); setSummary(''); setTotal(0); setDone(0); setErrs(0); setByteLoaded(0); setByteTotal(0);
    try {
      await streamUpload(id(), files, onEvent);
      setSelectedFiles([]);
      if (fileInputRef) fileInputRef.value = '';
      void refetch();
    } catch (e) {
      setSummary(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const doImport = async () => {
    const p = path().trim();
    if (!p || busy()) return;
    setBusy(true); setSummary(''); setTotal(0); setDone(0); setErrs(0);
    try {
      await streamImport(id(), p, onEvent);
      void refetch();
    } catch (e) {
      setSummary(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const onFileChange = (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    setSelectedFiles(Array.from(input.files ?? []));
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer?.files ?? []).filter(
      (f) => /\.(png|jpe?g|tiff?)$/i.test(f.name),
    );
    if (files.length) setSelectedFiles(files);
  };

  const items = (): LazyImageItem[] => (project()?.images ?? []).map((im) => ({
    key: im.id,
    src: imageUrls.overview(im.id),
    label: im.source_name ?? '',
    title: im.source_path ?? im.source_name ?? '',
  }));

  return (
    <ErrorBoundary fallback={<ProjectNotFound />}>
      <Show when={project()} fallback={<div class={styles.wrap}>{t('common.loading')}</div>}>
        {(p) => (
        <div class={styles.wrap} data-screen="project">
          <div class={styles.header}>
            <button class={styles.back} onClick={() => nav(`/projects/${id()}`)}>
              {t('detail.backHub')}
            </button>
            <h2 class={styles.title}>{t('detail.images', { count: p().images.length })}</h2>
          </div>

          {/* ── Primary: browser file upload ── */}
          <div class={styles.uploadSection}>
            <input type="file" multiple accept={IMAGE_ACCEPT}
              ref={fileInputRef} data-testid="import-files"
              class={styles.fileInputHidden} onChange={onFileChange} />
            <div class={styles.dropZone}
              classList={{ [styles.dropZoneOver]: dragging() }}
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              onClick={() => fileInputRef.click()}
            >
              <Show when={selectedFiles().length > 0}
                fallback={<span>{t('detail.images.dropHint')}</span>}>
                <span>{t('detail.images.filesSelected', { n: selectedFiles().length })}</span>
              </Show>
            </div>
            <button disabled={busy() || selectedFiles().length === 0}
              data-testid="upload-btn" class={styles.uploadBtn}
              onClick={() => void doUpload()}>
              {busy() ? t('detail.images.uploading') : t('detail.images.upload')}
            </button>
          </div>

          {/* ── Secondary (de-emphasized): server-path import for dev/admin ── */}
          <Show when={currentUser()?.is_admin}>
            <div class={styles.serverPathSection} data-testid="serverPathSection">
              <span class={styles.serverPathLabel}>{t('detail.images.serverPathSection')}</span>
              <div class={styles.importRow}>
                <input type="text" placeholder={t('detail.images.importPlaceholder')}
                  value={path()} data-testid="import-path"
                  onInput={(e) => setPath(e.currentTarget.value)} />
                <button disabled={busy()} onClick={() => void doImport()}>
                  {busy() ? t('detail.images.importing') : t('detail.images.import')}
                </button>
              </div>
            </div>
          </Show>

          {/* ── Shared progress UI (reused by both flows) ── */}
          <Show when={busy() || total() > 0}>
            <div class={styles.progressWrap} data-testid="import-progress">
              <div class={styles.progressTrack}>
                <div class={styles.progressBar} style={{ width: `${pct()}%` }}
                  data-testid="import-progress-bar" />
              </div>
              <span class={styles.progressLabel} data-testid="import-progress-label">
                {t('detail.images.progress', { done: done(), total: total(), errors: errs() })}
              </span>
            </div>
          </Show>
          <Show when={summary()}>
            <div class={styles.summary} data-testid="import-summary">{summary()}</div>
          </Show>

          <Show when={p().images.length > 0}
            fallback={<p class={styles.empty}>{t('detail.images.none')}</p>}>
            <LazyImageGrid items={items()} onSelect={setBoxId} />
          </Show>

          <Lightbox
            open={boxId() !== null}
            src={boxImage() ? imageUrls.overview(boxImage()!.id) : ''}
            caption={boxImage()?.source_path ?? boxImage()?.source_name ?? ''}
            onClose={() => setBoxId(null)}
          />
        </div>
        )}
      </Show>
    </ErrorBoundary>
  );
};

export default ProjectImagesScreen;
