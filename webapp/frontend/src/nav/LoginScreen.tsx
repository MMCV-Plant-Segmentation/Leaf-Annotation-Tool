import { type Component, createSignal } from 'solid-js';
import { setCurrentUser } from '../auth';
import { t } from '../i18n/catalog';
import * as styles from './LoginScreen.css';

const LoginScreen: Component = () => {
  const [username, setUsername] = createSignal('');
  const [password, setPassword] = createSignal('');
  const [error, setError]       = createSignal('');
  const [loading, setLoading]   = createSignal(false);

  const submit = async (e: Event) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/login', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ username: username(), password: password() }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok) {
        setError(data.error ?? t('login.error.default'));
        return;
      }
      const meRes = await fetch('/api/me');
      const user  = meRes.ok ? await meRes.json() : null;
      setCurrentUser(user);
      window.location.href = '/';
    } catch {
      setError(t('common.error.network'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <form class={styles.loginWrap} onSubmit={submit}>
      <h2 class={styles.title}>{t('login.title')}</h2>

      <div class={styles.field}>
        <label for="login-username">{t('login.username')}</label>
        <input
          id="login-username"
          type="text"
          autocomplete="username"
          value={username()}
          onInput={(e) => setUsername(e.currentTarget.value)}
          required
        />
      </div>

      <div class={styles.field}>
        <label for="login-password">{t('login.password')}</label>
        <input
          id="login-password"
          type="password"
          autocomplete="current-password"
          value={password()}
          onInput={(e) => setPassword(e.currentTarget.value)}
          required
        />
      </div>

      <div class={styles.error}>{error()}</div>

      <button class={styles.submitBtn} type="submit" disabled={loading()}>
        {loading() ? t('login.submitting') : t('login.submit')}
      </button>
    </form>
  );
};

export default LoginScreen;
