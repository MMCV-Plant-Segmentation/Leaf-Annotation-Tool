import { type Component, createResource, createSignal, For, Show } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { projectsApi, type ProjectSummary } from './api';
import { t } from '../i18n/catalog';
import * as styles from './ProjectsScreen.css';

const ProjectsScreen: Component = () => {
  const nav = useNavigate();
  const [projects, { mutate }] = createResource<ProjectSummary[]>(() => projectsApi.list());

  const [name, setName] = createSignal('');
  const [err, setErr] = createSignal('');
  const [busy, setBusy] = createSignal(false);

  const create = async (e: Event) => {
    e.preventDefault();
    const trimmed = name().trim();
    if (!trimmed) return;
    setErr('');
    setBusy(true);
    try {
      const p = await projectsApi.create({ name: trimmed });
      mutate((prev) => [{ ...p, imageCount: 0, batchCount: 0, annotatorCount: 0 }, ...(prev ?? [])]);
      setName('');
      nav(`/projects/${p.id}`);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Failed');
      setBusy(false);
    }
  };

  return (
    <div class={styles.wrap}>
      <h2 class={styles.title}>{t('projects.title')}</h2>

      <form class={styles.createForm} onSubmit={create}>
        <label class={styles.field}>
          <span>{t('projects.form.name')}</span>
          <input type="text" value={name()} placeholder={t('projects.form.namePlaceholder')}
            onInput={(e) => setName(e.currentTarget.value)} required />
        </label>
        <div class={styles.actions}>
          <button class={styles.btnPrimary} type="submit" disabled={busy()}>
            {busy() ? t('common.saving') : t('projects.form.create')}
          </button>
          <span class={styles.error}>{err()}</span>
        </div>
      </form>

      <Show when={projects.loading} fallback={null}>
        <div>{t('common.loading')}</div>
      </Show>
      <Show when={!projects.loading && projects()}>
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
