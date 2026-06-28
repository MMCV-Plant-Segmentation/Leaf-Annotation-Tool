/**
 * Batches sub-route (`/projects/:id/batches`): batch list + creation + open-as.
 * Guarded by tiling_confirmed (the ProjectBatchesStep shows the lock when not ready).
 */
import { type Component, createResource, Show } from 'solid-js';
import { useNavigate, useParams } from '@solidjs/router';
import { projectsApi } from './api';
import { t } from '../i18n/catalog';
import ProjectBatchesStep from './ProjectBatchesStep';
import * as styles from './ProjectBatchesScreen.css';

const ProjectBatchesScreen: Component = () => {
  const params = useParams();
  const nav = useNavigate();
  const id = () => params.id!;
  const [project, { refetch }] = createResource(id, (pid) => projectsApi.get(pid));

  return (
    <Show when={project()} fallback={<div class={styles.wrap}>{t('common.loading')}</div>}>
      {(p) => (
        <div class={styles.wrap} data-screen="project">
          <div class={styles.header}>
            <button class={styles.back} onClick={() => nav(`/projects/${id()}`)}>
              {t('detail.backHub')}
            </button>
            <h2 class={styles.title}>{t('detail.batches')}</h2>
          </div>
          <ProjectBatchesStep
            projectId={id()}
            batches={p().batches}
            annotators={p().annotators}
            tilingConfirmed={p().tiling_confirmed}
            onReload={() => void refetch()}
          />
        </div>
      )}
    </Show>
  );
};

export default ProjectBatchesScreen;
