import { type Component, For, Show } from 'solid-js';
import type { Progress } from './api';
import { t } from '../i18n/catalog';
import * as styles from './ProjectDetailScreen.css';

// Per-annotator progress for the current batch. Split out of ProjectDetailScreen
// to keep that file under the 200-line guard.
const ProjectProgressTable: Component<{ progress: Progress[] }> = (props) => (
  <Show when={props.progress.length > 0}>
    <section class={styles.panel}>
      <h3>{t('detail.progress')}</h3>
      <table class={styles.table}>
        <thead>
          <tr>
            <th>{t('detail.progress.annotator')}</th>
            <th>{t('detail.progress.tilesDone')}</th>
            <th>{t('detail.progress.lesions')}</th>
            <th>{t('detail.progress.vertices')}</th>
          </tr>
        </thead>
        <tbody>
          <For each={props.progress}>
            {(pr) => (
              <tr>
                <td>{pr.annotator}</td>
                <td>{t('detail.progress.tileCount', { done: pr.tilesCompleted, total: pr.tilesTotal })}</td>
                <td>{pr.lesionCount}</td>
                <td>{pr.vertexCount}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </section>
  </Show>
);

export default ProjectProgressTable;
