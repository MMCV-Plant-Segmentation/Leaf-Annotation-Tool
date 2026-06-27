import { type Component, createResource, createSignal, For, Show } from 'solid-js';
import { t } from '../i18n/catalog';
import * as styles from './AdminScreen.css';

type Invite = { token: string; expires: number };
type UserRow = { id: number; username: string; has_password: boolean; invite: Invite | null };

function fmtExpiry(ts: number): string {
  const secs = ts - Date.now() / 1000;
  if (secs <= 0) return 'expired';
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  return d > 0 ? `${d}d ${h}h` : `${h}h`;
}

function copyText(text: string) {
  void navigator.clipboard.writeText(text);
}

const UsersTab: Component = () => {
  const [users, { mutate }] = createResource<UserRow[]>(async () => {
    const r = await fetch('/api/users');
    return r.json() as Promise<UserRow[]>;
  });
  const [newName, setNewName] = createSignal('');
  const [addErr, setAddErr]   = createSignal('');
  const [busy, setBusy]       = createSignal(false);

  const addUser = async (e: Event) => {
    e.preventDefault();
    setAddErr('');
    setBusy(true);
    try {
      const r    = await fetch('/api/users', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ username: newName().trim() }),
      });
      const data = await r.json() as UserRow & { error?: string };
      if (!r.ok) { setAddErr(data.error ?? 'Error'); return; }
      mutate((prev) => [...(prev ?? []), data]);
      setNewName('');
    } finally {
      setBusy(false);
    }
  };

  const resetUser = async (id: number) => {
    const r    = await fetch(`/api/users/${id}/reset`, { method: 'POST' });
    const data = await r.json() as { ok: boolean; invite?: Invite };
    if (!r.ok || !data.invite) return;
    mutate((prev) => prev?.map((u) =>
      u.id === id ? { ...u, has_password: false, invite: data.invite! } : u
    ));
  };

  const deleteUser = async (id: number, username: string) => {
    if (!confirm(t('admin.user.deleteConfirm', { username }))) return;
    const r = await fetch(`/api/users/${id}`, { method: 'DELETE' });
    if (!r.ok) return;
    mutate((prev) => prev?.filter((u) => u.id !== id));
  };

  return (
    <div class={styles.section}>
      <h3 class={styles.sectionTitle}>{t('admin.tab.users')}</h3>

      <form class={styles.addRow} onSubmit={addUser}>
        <input
          type="text"
          placeholder={t('admin.user.placeholder')}
          value={newName()}
          onInput={(e) => setNewName(e.currentTarget.value)}
          required
        />
        <button class={styles.btnAdd} type="submit" disabled={busy()}>{t('admin.user.add')}</button>
      </form>
      <div class={styles.error}>{addErr()}</div>

      <Show when={users()} fallback={<div>{t('common.loading')}</div>}>
        <div class={styles.userList}>
          <For each={users()}>
            {(u) => (
              <div class={styles.userRow}>
                <div class={styles.userRowHeader}>
                  <span class={styles.userName}>{u.username}</span>
                  <Show when={!u.has_password}>
                    <span class={styles.badgeNoPass}>{t('admin.user.noPassword')}</span>
                  </Show>
                  <Show when={u.username !== 'admin'}>
                    <button class={styles.btnSm} onClick={() => void resetUser(u.id)}>
                      {t('admin.user.resetInvite')}
                    </button>
                    <button
                      class={`${styles.btnSm} ${styles.btnDanger}`}
                      onClick={() => void deleteUser(u.id, u.username)}
                    >
                      {t('admin.user.delete')}
                    </button>
                  </Show>
                </div>
                <Show when={u.invite}>
                  <div class={styles.inviteRow}>
                    <span>{t('admin.user.inviteExpires', { expiry: fmtExpiry(u.invite!.expires) })}</span>
                    <code class={styles.inviteCode}>{u.invite!.token}</code>
                    <button class={styles.btnSm} onClick={() => copyText(u.invite!.token)}>
                      {t('admin.user.copyCode')}
                    </button>
                    <button
                      class={styles.btnSm}
                      onClick={() => copyText(`${window.location.origin}/invite/${u.invite!.token}`)}
                    >
                      {t('admin.user.copyLink')}
                    </button>
                  </div>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};

export default UsersTab;
