import { type Accessor, type Component, createResource, Show } from 'solid-js';
import { t } from '../i18n/catalog';
import * as styles from './SyncStatusCard.css';
import { classifyAge, formatAgo, type Freshness } from './syncStatusFormat';

type SyncEntry = { lastSyncIso: string; ageSec: number } | null;
type SyncStatus =
  | { configured: false }
  | { configured: true; db: SyncEntry; files: SyncEntry; ok: boolean };

type Props = { backupDir: Accessor<string> };

const PILL_CLASS: Record<Freshness, string> = {
  green: styles.pillGreen,
  amber: styles.pillAmber,
  red: styles.pillRed,
};

/**
 * Admin-panel card surfacing backup/sync freshness — proxied from the `backup-status`
 * sidecar via GET /api/sync-status (see docs/plans/Plan — Admin sync-status panel.md).
 * Degrades to "not configured" when the endpoint reports `configured: false` (no
 * backup profile up, e.g. dev/local) — this is expected, not an error state.
 */
const SyncStatusCard: Component<Props> = (props) => {
  const [status] = createResource<SyncStatus>(async () => {
    const r = await fetch('/api/sync-status');
    return r.json() as Promise<SyncStatus>;
  });
  const configured = (): Extract<SyncStatus, { configured: true }> | undefined => {
    const s = status();
    return s && s.configured ? s : undefined;
  };

  return (
    <div class={styles.card} data-testid="sync-status-card">
      <h3 class={styles.title}>{t('admin.syncStatus.title')}</h3>
      <Show
        when={configured()}
        fallback={
          <span class={PILL_CLASS.red} data-testid="sync-status-not-configured">
            {t('admin.syncStatus.notConfigured')}
          </span>
        }
      >
        {(s) => {
          const dbAge = s().db?.ageSec ?? null;
          const filesAge = s().files?.ageSec ?? null;
          return (
            <dl class={styles.grid}>
              <dt>{t('admin.syncStatus.db')}</dt>
              <dd>
                <span class={PILL_CLASS[classifyAge(dbAge)]} data-testid="sync-status-db">
                  {formatAgo(dbAge)}
                </span>
              </dd>
              <dt>{t('admin.syncStatus.files')}</dt>
              <dd>
                <span class={PILL_CLASS[classifyAge(filesAge)]} data-testid="sync-status-files">
                  {formatAgo(filesAge)}
                </span>
              </dd>
              <dt>{t('admin.syncStatus.backupDir')}</dt>
              <dd class={styles.backupDirValue} data-testid="sync-status-dir">
                {props.backupDir() || t('admin.syncStatus.backupDirUnset')}
              </dd>
            </dl>
          );
        }}
      </Show>
    </div>
  );
};

export default SyncStatusCard;
