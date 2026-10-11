/**
 * t164: Admin > Settings checkbox for the whole-app MERGE_ENABLED flag (off by default).
 * Saves on change via the admin-only PATCH /api/settings, independent of the backup-dir
 * Save button; reports the outcome through the tab's shared saved/failed message.
 */
import { type Component, createSignal } from 'solid-js';
import { t } from '../i18n/catalog';
import { refreshGlobalSettings } from '../shared/globalSettings';
import * as settingsStyles from './SettingsTab.css';

type Props = {
  /** The stored MERGE_ENABLED value ("1" = on; anything else / absent = off). */
  initial: string | undefined;
  onSaved: (value: string) => void;
  onMessage: (msg: string) => void;
};

const MergeEnabledSetting: Component<Props> = (props) => {
  const [checked, setChecked] = createSignal(props.initial === '1');
  const [busy, setBusy] = createSignal(false);

  const onChange = async (e: Event & { currentTarget: HTMLInputElement }) => {
    const box = e.currentTarget;
    const next = box.checked;
    const value = next ? '1' : '0';
    props.onMessage('');
    setBusy(true);
    try {
      const r = await fetch('/api/settings', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ MERGE_ENABLED: value }),
      });
      if (!r.ok) throw new Error(String(r.status));
      setChecked(next);
      void refreshGlobalSettings();  // this tab's merge buttons follow without a reload
      props.onSaved(value);
      props.onMessage(t('common.saved'));
    } catch {
      box.checked = !next;
      props.onMessage(t('admin.settings.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <label class={settingsStyles.settingsCheck}>
      <input
        type="checkbox"
        data-testid="setting-merge-enabled"
        checked={checked()}
        disabled={busy()}
        onChange={onChange}
      />
      {t('admin.settings.mergeEnabledLabel')}
    </label>
  );
};

export default MergeEnabledSetting;
