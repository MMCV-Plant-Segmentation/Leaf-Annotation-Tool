/**
 * Project config HUB (`/projects/:id`): roster + per-annotator progress + step cards.
 *
 * The step cards link out to the dedicated sub-routes (images / tiling / batches) and
 * carry the dependency locks ("Import images first" / "Configure tiling first"). A
 * delete-project control (rows-only on the backend; blob left on disk) lives here too.
 */
import { type Component, createResource, createSignal, ErrorBoundary, Show } from 'solid-js';
import { useNavigate, useParams } from '@solidjs/router';
import { projectsApi } from './api';
import { t } from '../i18n/catalog';
import ProjectProgressTable from './ProjectProgressTable';
import ProjectRosterSection from './ProjectRosterSection';
import ProjectStepCards from './ProjectStepCards';
import ProjectNotFound from './ProjectNotFound';
import LabelEditor from './LabelEditor';
import * as styles from './ProjectHubScreen.css';

const ProjectHubScreen: Component = () => {
  const params = useParams();
  const nav = useNavigate();
  const id = () => params.id!;

  const [project, { refetch }] = createResource(id, (pid) => projectsApi.get(pid));
  const reload = () => void refetch();

  const [confirming, setConfirming] = createSignal(false);
  const [deleting, setDeleting] = createSignal(false);

  const doDelete = async () => {
    setDeleting(true);
    try {
      await projectsApi.remove(id());
      nav('/projects');
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Delete failed');
      setDeleting(false);
    }
  };

  return (
    <ErrorBoundary fallback={<ProjectNotFound />}>
      <Show when={project()} fallback={<div class={styles.wrap}>{t('common.loading')}</div>}>
        {(p) => (
          <div class={styles.wrap} data-screen="project">
            <div class={styles.header}>
              <button class={styles.back} onClick={() => nav('/projects')}>
                {t('detail.back')}
              </button>
              <h2 class={styles.title}>{p().name}</h2>
              <span class={styles.sub}>
                {t('detail.tile.sub', { px: p().tile_size_px, threshold: p().black_threshold })}
              </span>
            </div>

            <ProjectStepCards
              projectId={id()}
              hasImages={p().images.length > 0}
              tilingConfirmed={p().tiling_confirmed}
              imageCount={p().images.length}
              batchCount={p().batches.length}
            />

            <ProjectRosterSection projectId={id()} annotators={p().annotators} onReload={reload} />

            {/* ── Label taxonomy editor (any project member — not admin-only) ── */}
            <LabelEditor projectId={id()} labels={p().classes} groups={p().groups ?? []}
              compounds={p().compounds ?? []} onSaved={reload} />

            <ProjectProgressTable progress={p().progress} />

            <section class={styles.dangerZone}>
              <Show
                when={confirming()}
                fallback={
                  <button
                    class={styles.deleteBtn}
                    data-testid="delete-project"
                    onClick={() => setConfirming(true)}
                  >{t('detail.delete.button')}</button>
                }
              >
                <span class={styles.confirmText}>{t('detail.delete.confirm', { name: p().name })}</span>
                <button
                  class={styles.deleteBtn}
                  data-testid="delete-project-confirm"
                  disabled={deleting()}
                  onClick={() => void doDelete()}
                >{deleting() ? t('common.saving') : t('detail.delete.yes')}</button>
                <button class={styles.cancelBtn} onClick={() => setConfirming(false)}>
                  {t('common.cancel')}
                </button>
              </Show>
            </section>
          </div>
        )}
      </Show>
    </ErrorBoundary>
  );
};

export default ProjectHubScreen;
