import { type Component, createSignal } from 'solid-js';
import { setCurrentUser } from '../auth';
import styles from './LoginScreen.module.css';

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
        setError(data.error ?? 'Login failed');
        return;
      }
      const meRes = await fetch('/api/me');
      const user  = meRes.ok ? await meRes.json() : null;
      setCurrentUser(user);
      window.location.href = '/';
    } catch {
      setError('Network error — please try again');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form class={styles.loginWrap} onSubmit={submit}>
      <h2 class={styles.title}>Sign in</h2>

      <div class={styles.field}>
        <label for="login-username">Username</label>
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
        <label for="login-password">Password</label>
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
        {loading() ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
};

export default LoginScreen;
