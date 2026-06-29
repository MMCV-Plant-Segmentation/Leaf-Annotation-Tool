import { type Component, createResource, createSignal, Match, onMount, Switch } from 'solid-js';
import { useParams } from '@solidjs/router';
import { fetchMe } from '../auth';
import { t } from '../i18n/catalog';
import * as styles from './InviteScreen.css';

type InviteInfo = { username: string } | { error: string };

const InviteScreen: Component = () => {
  const params = useParams<{ token: string }>();

  // On mount: log out any active session so an admin who opens an invite link is
  // immediately cleared. The invite GET (below) also clears the server session, so
  // the explicit logout is belt-and-suspenders; fetchMe() then syncs the client store.
  onMount(() => {
    void fetch('/api/logout', { method: 'POST' }).then(() => void fetchMe());
  });

  const [info] = createResource<InviteInfo>(async () => {
    const r = await fetch(`/api/invite/${params.token}`);
    return r.json() as Promise<InviteInfo>;
  });

  const [password, setPassword]   = createSignal('');
  const [confirm, setConfirm]     = createSignal('');
  const [error, setError]         = createSignal('');
  const [success, setSuccess]     = createSignal(false);
  const [loading, setLoading]     = createSignal(false);

  const submit = async (e: Event) => {
    e.preventDefault();
    setError('');
    if (password() !== confirm()) { setError(t('invite.error.mismatch')); return; }
    if (password().length < 8)   { setError(t('invite.error.short')); return; }
    setLoading(true);
    try {
      const r    = await fetch(`/api/invite/${params.token}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ password: password(), confirm: confirm() }),
      });
      const data = await r.json() as { ok?: boolean; error?: string };
      if (!r.ok) { setError(data.error ?? t('invite.error.default')); return; }
      setSuccess(true);
    } catch {
      setError(t('common.error.network'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Switch fallback={<div>{t('common.loading')}</div>}>
      <Match when={success()}>
        <div class={styles.wrap}>
          <h2 class={styles.title}>{t('invite.title.success')}</h2>
          <p class={styles.greeting}>{t('invite.success')} <a href="/login">{t('login.submit')}</a>.</p>
        </div>
      </Match>
      <Match when={info() && 'error' in info()!}>
        <div class={styles.wrap}>
          <h2 class={styles.title}>{t('invite.title.invalid')}</h2>
          <p class={styles.greeting}>{t('invite.invalid')}</p>
        </div>
      </Match>
      <Match when={info() && 'username' in info()!}>
        <form class={styles.wrap} onSubmit={submit}>
          <h2 class={styles.title}>{t('invite.title.setPassword')}</h2>
          <p class={styles.greeting}>
            {t('invite.greeting', { username: (info() as { username: string }).username })}
          </p>

          <div class={styles.field}>
            <label for="invite-password">{t('invite.password')}</label>
            <input
              id="invite-password"
              type="password"
              autocomplete="new-password"
              value={password()}
              onInput={(e) => setPassword(e.currentTarget.value)}
              required
            />
          </div>

          <div class={styles.field}>
            <label for="invite-confirm">{t('invite.confirm')}</label>
            <input
              id="invite-confirm"
              type="password"
              autocomplete="new-password"
              value={confirm()}
              onInput={(e) => setConfirm(e.currentTarget.value)}
              required
            />
          </div>

          <div class={styles.error}>{error()}</div>

          <button class={styles.submitBtn} type="submit" disabled={loading()}>
            {loading() ? t('invite.submitting') : t('invite.submit')}
          </button>
        </form>
      </Match>
    </Switch>
  );
};

export default InviteScreen;
