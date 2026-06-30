/**
 * Tiny fallback rendered when a project resource rejects (404 / deleted).
 * Used by ProjectHubScreen, ProjectImagesScreen, ProjectTilingScreen,
 * ProjectBatchesScreen in place of infinite loading.
 */
import { type Component } from 'solid-js';
import { A } from '@solidjs/router';
import { t } from '../i18n/catalog';
import * as styles from './ProjectNotFound.css';

const ProjectNotFound: Component = () => (
  <div class={styles.wrap}>
    <p class={styles.msg}>{t('project.notFound')}</p>
    <A href="/projects" class={styles.link}>{t('project.backToList')}</A>
  </div>
);

export default ProjectNotFound;
