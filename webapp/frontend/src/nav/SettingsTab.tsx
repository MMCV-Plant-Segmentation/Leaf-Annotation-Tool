import { type Component, createResource, createSignal, Show } from 'solid-js';
import { t } from '../i18n/catalog';
import VersionCard from './VersionCard';
import * as styles from './AdminScreen.css';
import * as settingsStyles from './SettingsTab.css';

type Settings = Record<string, { value: string; updated_at: number | null }>;

const SettingsTab: Component = () => {
  const [settings, { mutate }] = createResource<Settings>(async () => {
    const r = await fetch('/api/settings');
    return r.json() as Promise<Settings>;
  });
  const [backupDir, setBackupDir] = createSignal('');
  const [msg, setMsg]             = createSignal('');
  const [busy, setBusy]           = createSignal(false);

  // Keep local input in sync when resource loads
  const initBackupDir = () => {
    const s = settings();
    if (s && backupDir() === '') setBackupDir(s['BACKUP_DIR']?.value ?? '');
  };

  const save = async (e: Event) => {
    e.preventDefault();
    setMsg('');
    setBusy(true);
    const s = settings();
    const client_updated_at = s?.['BACKUP_DIR']?.updated_at ?? null;
    try {
      const r = await fetch('/api/settings', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ BACKUP_DIR: backupDir(), updated_at: client_updated_at }),
      });
      const data = await r.json() as { ok?: boolean; conflict?: string[] };
      if (!r.ok) {
        setMsg(data.conflict ? t('admin.settings.conflict') : t('admin.settings.saveFailed'));
        return;
      }
      mutate((prev) => ({
        ...prev,
        BACKUP_DIR: { value: backupDir(), updated_at: Date.now() / 1000 },
      }));
      setMsg(t('common.saved'));
      setTimeout(() => setMsg(''), 3000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Show when={settings()} fallback={<div>{t('common.loading')}</div>} keyed>
        {(s) => {
          initBackupDir();
          void s;
          return (
            <form class={styles.section} onSubmit={save}>
              <h3 class={styles.sectionTitle}>{t('admin.tab.settings')}</h3>

              <div class={settingsStyles.settingsField}>
                <label for="setting-backup-dir">{t('admin.settings.backupDirLabel')}</label>
                <input
                  id="setting-backup-dir"
                  type="text"
                  value={backupDir()}
                  onInput={(e) => setBackupDir(e.currentTarget.value)}
                  placeholder={t('admin.settings.backupDirPlaceholder')}
                />
              </div>

              <button class={settingsStyles.settingsSave} type="submit" disabled={busy()}>
                {busy() ? t('admin.settings.saving') : t('common.save')}
              </button>
              <div class={settingsStyles.settingsMsg}>{msg()}</div>
            </form>
          );
        }}
      </Show>
      <VersionCard />
    </>
  );
};

export default SettingsTab;
