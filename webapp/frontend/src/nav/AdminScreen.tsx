import { type Component, createResource, createSignal, For, Show } from 'solid-js';
import styles from './AdminScreen.module.css';

type Invite = { token: string; expires: number };
type UserRow = { id: number; username: string; has_password: boolean; invite: Invite | null };
type Settings = Record<string, { value: string; updated_at: number | null }>;

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

// ── Users tab ─────────────────────────────────────────────────────────────────

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
    if (!confirm(`Delete user "${username}"? This cannot be undone.`)) return;
    const r = await fetch(`/api/users/${id}`, { method: 'DELETE' });
    if (!r.ok) return;
    mutate((prev) => prev?.filter((u) => u.id !== id));
  };

  return (
    <div class={styles.section}>
      <h3 class={styles.sectionTitle}>Users</h3>

      <form class={styles.addRow} onSubmit={addUser}>
        <input
          type="text"
          placeholder="New username"
          value={newName()}
          onInput={(e) => setNewName(e.currentTarget.value)}
          required
        />
        <button class={styles.btnAdd} type="submit" disabled={busy()}>Add</button>
      </form>
      <div class={styles.error}>{addErr()}</div>

      <Show when={users()} fallback={<div>Loading…</div>}>
        <div class={styles.userList}>
          <For each={users()}>
            {(u) => (
              <div class={styles.userRow}>
                <div class={styles.userRowHeader}>
                  <span class={styles.userName}>{u.username}</span>
                  <Show when={!u.has_password}>
                    <span class={styles.badgeNoPass}>no password</span>
                  </Show>
                  <Show when={u.username !== 'admin'}>
                    <button class={styles.btnSm} onClick={() => void resetUser(u.id)}>
                      Reset invite
                    </button>
                    <button
                      class={`${styles.btnSm} ${styles.btnDanger}`}
                      onClick={() => void deleteUser(u.id, u.username)}
                    >
                      Delete
                    </button>
                  </Show>
                </div>
                <Show when={u.invite}>
                  <div class={styles.inviteRow}>
                    <span>Invite (expires {fmtExpiry(u.invite!.expires)}):</span>
                    <code class={styles.inviteCode}>{u.invite!.token}</code>
                    <button class={styles.btnSm} onClick={() => copyText(u.invite!.token)}>
                      Copy code
                    </button>
                    <button
                      class={styles.btnSm}
                      onClick={() => copyText(`${window.location.origin}/invite/${u.invite!.token}`)}
                    >
                      Copy link
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

// ── Settings tab ──────────────────────────────────────────────────────────────

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
        setMsg(data.conflict ? 'Conflict — another session updated this setting' : 'Save failed');
        return;
      }
      mutate((prev) => ({
        ...prev,
        BACKUP_DIR: { value: backupDir(), updated_at: Date.now() / 1000 },
      }));
      setMsg('Saved');
      setTimeout(() => setMsg(''), 3000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Show when={settings()} fallback={<div>Loading…</div>} keyed>
      {(s) => {
        initBackupDir();
        void s;
        return (
          <form class={styles.section} onSubmit={save}>
            <h3 class={styles.sectionTitle}>Settings</h3>

            <div class={styles.settingsField}>
              <label for="setting-backup-dir">Backup directory (BACKUP_DIR)</label>
              <input
                id="setting-backup-dir"
                type="text"
                value={backupDir()}
                onInput={(e) => setBackupDir(e.currentTarget.value)}
                placeholder="/path/to/backup"
              />
            </div>

            <button class={styles.settingsSave} type="submit" disabled={busy()}>
              {busy() ? 'Saving…' : 'Save'}
            </button>
            <div class={styles.settingsMsg}>{msg()}</div>
          </form>
        );
      }}
    </Show>
  );
};

// ── AdminScreen ───────────────────────────────────────────────────────────────

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
          Users
        </button>
        <button
          class={styles.tab}
          role="tab"
          aria-selected={tab() === 'settings'}
          onClick={() => setTab('settings')}
        >
          Settings
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
