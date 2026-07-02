import { type Component, createSignal } from 'solid-js';
import { currentUser, setCurrentUser } from '../auth';
import { t } from '../i18n/catalog';
import * as styles from './AccountScreen.css';

const AccountScreen: Component = () => {
  const [username, setUsername]         = createSignal(currentUser()?.username ?? '');
  const [usernameErr, setUsernameErr]   = createSignal('');
  const [usernameMsg, setUsernameMsg]   = createSignal('');
  const [usernameBusy, setUsernameBusy] = createSignal(false);

  const [current, setCurrent]           = createSignal('');
  const [next, setNext]                 = createSignal('');
  const [confirm, setConfirm]           = createSignal('');
  const [passErr, setPassErr]           = createSignal('');
  const [passMsg, setPassMsg]           = createSignal('');
  const [passBusy, setPassBusy]         = createSignal(false);

  const submitUsername = async (e: Event) => {
    e.preventDefault();
    setUsernameErr('');
    setUsernameMsg('');
    setUsernameBusy(true);
    try {
      const r = await fetch('/api/me/username', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ username: username() }),
      });
      const data = await r.json() as { ok?: boolean; username?: string; error?: string };
      if (!r.ok) {
        setUsernameErr(data.error ?? t('account.username.error.default'));
        return;
      }
      const user = currentUser();
      if (user) setCurrentUser({ ...user, username: data.username! });
      setUsernameMsg(t('account.username.success'));
    } catch {
      setUsernameErr(t('common.error.network'));
    } finally {
      setUsernameBusy(false);
    }
  };

  const submitPassword = async (e: Event) => {
    e.preventDefault();
    setPassErr('');
    setPassMsg('');
    if (next() !== confirm()) { setPassErr(t('account.password.error.mismatch')); return; }
    if (next().length < 8)    { setPassErr(t('account.password.error.short')); return; }
    setPassBusy(true);
    try {
      const r = await fetch('/api/me/password', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ current_password: current(), password: next(), confirm: confirm() }),
      });
      const data = await r.json() as { ok?: boolean; error?: string };
      if (!r.ok) {
        setPassErr(data.error ?? t('account.password.error.default'));
        return;
      }
      setCurrent('');
      setNext('');
      setConfirm('');
      setPassMsg(t('account.password.success'));
    } catch {
      setPassErr(t('common.error.network'));
    } finally {
      setPassBusy(false);
    }
  };

  return (
    <div class={styles.wrap}>
      <h2 class={styles.title}>{t('account.title')}</h2>

      <form class={styles.section} onSubmit={submitUsername}>
        <h3 class={styles.sectionTitle}>{t('account.username.title')}</h3>
        <div class={styles.field}>
          <label for="account-username">{t('account.username.label')}</label>
          <input
            id="account-username"
            type="text"
            autocomplete="username"
            value={username()}
            onInput={(e) => setUsername(e.currentTarget.value)}
            required
          />
        </div>
        <div class={styles.error}>{usernameErr()}</div>
        <div class={styles.success}>{usernameMsg()}</div>
        <button class={styles.submitBtn} type="submit" disabled={usernameBusy()}>
          {usernameBusy() ? t('account.username.saving') : t('account.username.save')}
        </button>
      </form>

      <form class={styles.section} onSubmit={submitPassword}>
        <h3 class={styles.sectionTitle}>{t('account.password.title')}</h3>
        <div class={styles.field}>
          <label for="account-current-password">{t('account.password.current')}</label>
          <input
            id="account-current-password"
            type="password"
            autocomplete="current-password"
            value={current()}
            onInput={(e) => setCurrent(e.currentTarget.value)}
            required
          />
        </div>
        <div class={styles.field}>
          <label for="account-new-password">{t('account.password.new')}</label>
          <input
            id="account-new-password"
            type="password"
            autocomplete="new-password"
            value={next()}
            onInput={(e) => setNext(e.currentTarget.value)}
            required
          />
        </div>
        <div class={styles.field}>
          <label for="account-confirm-password">{t('account.password.confirm')}</label>
          <input
            id="account-confirm-password"
            type="password"
            autocomplete="new-password"
            value={confirm()}
            onInput={(e) => setConfirm(e.currentTarget.value)}
            required
          />
        </div>
        <div class={styles.error}>{passErr()}</div>
        <div class={styles.success}>{passMsg()}</div>
        <button class={styles.submitBtn} type="submit" disabled={passBusy()}>
          {passBusy() ? t('account.password.saving') : t('account.password.save')}
        </button>
      </form>
    </div>
  );
};

export default AccountScreen;
