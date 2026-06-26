import { type Component, createResource, createSignal, Match, Switch } from 'solid-js';
import { useParams } from '@solidjs/router';
import styles from './InviteScreen.module.css';

type InviteInfo = { username: string } | { error: string };

const InviteScreen: Component = () => {
  const params = useParams<{ token: string }>();

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
    if (password() !== confirm()) { setError('Passwords do not match'); return; }
    if (password().length < 8)   { setError('Password must be at least 8 characters'); return; }
    setLoading(true);
    try {
      const r    = await fetch(`/api/invite/${params.token}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ password: password(), confirm: confirm() }),
      });
      const data = await r.json() as { ok?: boolean; error?: string };
      if (!r.ok) { setError(data.error ?? 'Failed'); return; }
      setSuccess(true);
    } catch {
      setError('Network error — please try again');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Switch fallback={<div>Loading…</div>}>
      <Match when={success()}>
        <div class={styles.wrap}>
          <h2 class={styles.title}>Password set!</h2>
          <p class={styles.greeting}>You can now <a href="/login">sign in</a>.</p>
        </div>
      </Match>
      <Match when={info() && 'error' in info()!}>
        <div class={styles.wrap}>
          <h2 class={styles.title}>Invalid invite</h2>
          <p class={styles.greeting}>This invite link has expired or already been used.</p>
        </div>
      </Match>
      <Match when={info() && 'username' in info()!}>
        <form class={styles.wrap} onSubmit={submit}>
          <h2 class={styles.title}>Set your password</h2>
          <p class={styles.greeting}>
            You're signing up as <strong>{(info() as { username: string }).username}</strong>.
          </p>

          <div class={styles.field}>
            <label for="invite-password">Password</label>
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
            <label for="invite-confirm">Confirm password</label>
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
            {loading() ? 'Setting password…' : 'Set password'}
          </button>
        </form>
      </Match>
    </Switch>
  );
};

export default InviteScreen;
