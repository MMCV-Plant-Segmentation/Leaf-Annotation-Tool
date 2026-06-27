import { type Component, createResource, createSignal, For, Show } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { projectsApi, type ProjectSummary } from './api';
import { t } from '../i18n/catalog';
import * as styles from './ProjectsScreen.css';

const ProjectsScreen: Component = () => {
  const nav = useNavigate();
  const [projects, { mutate, refetch }] = createResource<ProjectSummary[]>(() => projectsApi.list());

  const [name, setName] = createSignal('');
  const [tileSize, setTileSize] = createSignal(128);
  const [threshold, setThreshold] = createSignal(40);
  const [classesText, setClassesText] = createSignal('lesion');
  const [err, setErr] = createSignal('');
  const [busy, setBusy] = createSignal(false);

  const create = async (e: Event) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const classes = classesText().split(',').map((c) => c.trim()).filter(Boolean);
      const p = await projectsApi.create({
        name: name().trim(),
        tile_size_px: tileSize(),
        black_threshold: threshold(),
        classes,
      });
      mutate((prev) => [{ ...p, imageCount: 0, batchCount: 0, annotatorCount: 0 }, ...(prev ?? [])]);
      setName('');
      void refetch();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class={styles.wrap}>
      <h2 class={styles.title}>{t('projects.title')}</h2>

      <form class={styles.createForm} onSubmit={create}>
        <div class={styles.row}>
          <label class={styles.field}>
            <span>{t('projects.form.name')}</span>
            <input type="text" value={name()} placeholder={t('projects.form.namePlaceholder')}
              onInput={(e) => setName(e.currentTarget.value)} required />
          </label>
          <label class={styles.fieldSm}>
            <span>{t('projects.form.tileSize')}</span>
            <input type="number" min="8" value={tileSize()}
              onInput={(e) => setTileSize(Number(e.currentTarget.value))} />
          </label>
          <label class={styles.fieldSm}>
            <span>{t('projects.form.blackThreshold')}</span>
            <input type="number" min="0" max="255" value={threshold()}
              onInput={(e) => setThreshold(Number(e.currentTarget.value))} />
          </label>
        </div>
        <label class={styles.field}>
          <span>{t('projects.form.classes')}</span>
          <input type="text" value={classesText()}
            onInput={(e) => setClassesText(e.currentTarget.value)} />
        </label>
        <div class={styles.actions}>
          <button class={styles.btnPrimary} type="submit" disabled={busy()}>{t('projects.form.create')}</button>
          <span class={styles.error}>{err()}</span>
        </div>
        <p class={styles.hint}>{t('projects.form.hint')}</p>
      </form>

      <Show when={projects()} fallback={<div>{t('common.loading')}</div>}>
        <Show when={projects()!.length > 0} fallback={<p class={styles.empty}>{t('projects.empty')}</p>}>
          <ul class={styles.list}>
            <For each={projects()}>
              {(p) => (
                <li class={styles.card} onClick={() => nav(`/projects/${p.id}`)}>
                  <strong class={styles.cardName}>{p.name}</strong>
                  <div class={styles.cardMeta}>
                    <span>{t('projects.images', { count: p.imageCount })}</span>
                    <span>{t('projects.annotators', { count: p.annotatorCount })}</span>
                    <span>{t('projects.batches', { count: p.batchCount })}</span>
                    <span>{t('projects.tiles', { px: p.tile_size_px })}</span>
                  </div>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>
    </div>
  );
};

export default ProjectsScreen;
