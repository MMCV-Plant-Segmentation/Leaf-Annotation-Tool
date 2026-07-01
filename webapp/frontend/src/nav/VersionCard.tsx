import { type Component, createResource, Show } from 'solid-js';
import { t } from '../i18n/catalog';
import { fetchVersion } from '../shared/versionApi';
import * as styles from './VersionCard.css';

/**
 * Full version readout for the admin Settings panel — appVersion, gitSha, builtAt,
 * schemaVersion. Shares the same cached /api/version fetch as the app-shell footer.
 */
const VersionCard: Component = () => {
  const [version] = createResource(fetchVersion);

  return (
    <Show when={version()}>
      {(v) => (
        <div class={styles.card} data-testid="version-card">
          <h3 class={styles.title}>{t('admin.version.title')}</h3>
          <dl class={styles.grid}>
            <dt>{t('admin.version.appVersion')}</dt>
            <dd data-testid="version-card-appVersion">{v().appVersion}</dd>
            <dt>{t('admin.version.gitSha')}</dt>
            <dd data-testid="version-card-gitSha">{v().gitSha}</dd>
            <dt>{t('admin.version.builtAt')}</dt>
            <dd data-testid="version-card-builtAt">{v().builtAt}</dd>
            <dt>{t('admin.version.schemaVersion')}</dt>
            <dd data-testid="version-card-schemaVersion">{v().schemaVersion ?? '—'}</dd>
          </dl>
        </div>
      )}
    </Show>
  );
};

export default VersionCard;
