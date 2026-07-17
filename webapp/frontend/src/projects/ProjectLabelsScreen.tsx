/**
 * Labels sub-route (`/projects/:id/labels`): the per-project taxonomy editor (groups +
 * saved compound labels), promoted out of the hub to its own page like the other project
 * settings (images / tiling / batches). Any project member — not admin-only.
 */
import { type Component, createResource, ErrorBoundary, Show } from 'solid-js';
import { useNavigate, useParams } from '@solidjs/router';
import { projectsApi } from './api';
import { t } from '../i18n/catalog';
import LabelEditor from './LabelEditor';
import ProjectNotFound from './ProjectNotFound';
import * as styles from './ProjectHubScreen.css';

const ProjectLabelsScreen: Component = () => {
  const params = useParams();
  const nav = useNavigate();
  const id = () => params.id!;
  const [project, { refetch }] = createResource(id, (pid) => projectsApi.get(pid));

  return (
    <ErrorBoundary fallback={<ProjectNotFound />}>
      <Show when={project()} fallback={<div class={styles.wrap}>{t('common.loading')}</div>}>
        {(p) => (
          <div class={styles.wrap} data-screen="labels">
            <div class={styles.header}>
              <button class={styles.back} onClick={() => nav(`/projects/${id()}`)}>
                {t('detail.backHub')}
              </button>
              <h2 class={styles.title}>{p().name}</h2>
            </div>
            <LabelEditor projectId={id()} labels={p().classes} groups={p().groups ?? []}
              compounds={p().compounds ?? []} onSaved={() => void refetch()} />
          </div>
        )}
      </Show>
    </ErrorBoundary>
  );
};

export default ProjectLabelsScreen;
