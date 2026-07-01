import { type Component, createResource, Show } from 'solid-js';
import { t } from '../i18n/catalog';
import { fetchVersion } from '../shared/versionApi';
import * as styles from './VersionFooter.css';

/**
 * Small, unobtrusive build identity in the corner of the authenticated shell —
 * `v0.1.0 · 1d24de3`. Fetches /api/version once (shared cache with the admin
 * Settings version card) and stays quiet if it fails.
 */
const VersionFooter: Component = () => {
  const [version] = createResource(fetchVersion);

  return (
    <Show when={version()}>
      {(v) => (
        <div class={styles.footer} data-testid="version-footer">
          {t('nav.versionFooter', { version: v().appVersion, sha: v().gitSha })}
        </div>
      )}
    </Show>
  );
};

export default VersionFooter;
