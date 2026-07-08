/**
 * De-emphasized server-path import (dev/admin use only) — extracted from
 * ProjectImagesScreen to keep that file under 200 lines. Browser upload (drag/drop or
 * file picker) is the primary ingress; this is a secondary convenience for importing
 * from a path already on the server's filesystem.
 */
import { type Component } from 'solid-js';
import { t } from '../i18n/catalog';
import * as styles from './ProjectImagesScreen.css';

type Props = {
  path: () => string;
  setPath: (v: string) => void;
  busy: () => boolean;
  onImport: () => void;
};

export const ServerPathImportSection: Component<Props> = (props) => (
  <div class={styles.serverPathSection} data-testid="serverPathSection">
    <span class={styles.serverPathLabel}>{t('detail.images.serverPathSection')}</span>
    <div class={styles.importRow}>
      <input type="text" placeholder={t('detail.images.importPlaceholder')}
        value={props.path()} data-testid="import-path"
        onInput={(e) => props.setPath(e.currentTarget.value)} />
      <button disabled={props.busy()} onClick={props.onImport}>
        {props.busy() ? t('detail.images.importing') : t('detail.images.import')}
      </button>
    </div>
  </div>
);

export default ServerPathImportSection;
