import { type Component, createSignal, Show } from 'solid-js';
import { t } from '../i18n/catalog';
import UsersTab from './UsersTab';
import SettingsTab from './SettingsTab';
import * as styles from './AdminScreen.css';

const AdminScreen: Component = () => {
  const [tab, setTab] = createSignal<'users' | 'settings'>('users');

  return (
    <div class={styles.wrap}>
      <div class={styles.tabs} role="tablist">
        <button
          class={styles.tab}
          role="tab"
          aria-selected={tab() === 'users'}
          onClick={() => setTab('users')}
        >
          {t('admin.tab.users')}
        </button>
        <button
          class={styles.tab}
          role="tab"
          aria-selected={tab() === 'settings'}
          onClick={() => setTab('settings')}
        >
          {t('admin.tab.settings')}
        </button>
      </div>

      <Show when={tab() === 'users'}>
        <UsersTab />
      </Show>
      <Show when={tab() === 'settings'}>
        <SettingsTab />
      </Show>
    </div>
  );
};

export default AdminScreen;
