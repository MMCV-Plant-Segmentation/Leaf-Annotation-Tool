/**
 * Renders the header + scrollable filename list shown inside the upload drop zone once
 * files are selected. Capped at FILE_LIST_CAP rendered rows (see ProjectImagesScreen) so a
 * 500-file selection doesn't blow up the DOM — the remainder collapses into a "+N more" line.
 */
import { type Component, For, Show } from 'solid-js';
import { t } from '../i18n/catalog';
import * as styles from './ProjectImagesScreen.css';

const FILE_LIST_CAP = 100;

const SelectedFilesList: Component<{ files: File[] }> = (props) => (
  <>
    <div class={styles.fileListHeader}>
      {t('detail.images.filesSelected', { n: props.files.length })}
    </div>
    <div class={styles.fileList} data-testid="selected-files-list">
      <For each={props.files.slice(0, FILE_LIST_CAP)}>
        {(f) => <div class={styles.fileListItem}>{f.name}</div>}
      </For>
      <Show when={props.files.length > FILE_LIST_CAP}>
        <div class={styles.fileListMore}>
          {t('detail.images.filesMore', { n: props.files.length - FILE_LIST_CAP })}
        </div>
      </Show>
    </div>
  </>
);

export default SelectedFilesList;
