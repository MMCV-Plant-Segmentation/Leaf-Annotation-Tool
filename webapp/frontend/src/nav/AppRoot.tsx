import { type Component, createSignal, createEffect, Show } from 'solid-js';
import { useLocation, useNavigate } from '@solidjs/router';
import type { RouteSectionProps } from '@solidjs/router';
import { currentUser, fetchMe, logout } from '../auth';
import { darkThemeClass, lightThemeClass, THEME_STORAGE_KEY } from '../theme/index';
import { t } from '../i18n/catalog';
import * as styles from './AppRoot.css';

const w = window as any;

const PUBLIC_ROUTES = new Set(['/login', '/invite']);

const AppRoot: Component<RouteSectionProps> = (props) => {
  const nav = useNavigate();
  const loc = useLocation();
  w._navigate = (to: string) => nav(to);

  fetchMe().then((user) => {
    if (!user && !PUBLIC_ROUTES.has(loc.pathname) && !loc.pathname.startsWith('/invite/')) {
      nav('/login', { replace: true });
    }
  });

  createEffect(() => {
    const user = currentUser();
    if (user && loc.pathname === '/login') {
      nav('/', { replace: true });
    }
    // Gate /admin: resolved + logged-in + not admin → bounce home.
    if (user !== undefined && user && !user.is_admin && loc.pathname === '/admin') {
      nav('/', { replace: true });
    }
  });

  const isPublic = () =>
    PUBLIC_ROUTES.has(loc.pathname) || loc.pathname.startsWith('/invite/');

  // Theme toggle state: track whether we're in light mode
  const [isLight, setIsLight] = createSignal(
    document.body.classList.contains(lightThemeClass),
  );

  function handleToggle() {
    const nowLight = isLight();
    if (nowLight) {
      document.body.classList.remove(lightThemeClass);
      document.body.classList.add(darkThemeClass);
      localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    } else {
      document.body.classList.remove(darkThemeClass);
      document.body.classList.add(lightThemeClass);
      localStorage.setItem(THEME_STORAGE_KEY, 'light');
    }
    setIsLight(!nowLight);
  }

  return (
    <>
      <Show when={currentUser() && !isPublic()}>
        <div class={styles.authBar}>
          <span data-testid="auth-username">{currentUser()!.username}</span>
          <Show when={currentUser()!.is_admin}>
            <button class={styles.authBarBtn} onClick={() => nav('/admin')}>{t('nav.admin')}</button>
          </Show>
          <button class={styles.authBarBtn} onClick={() => void logout()}>{t('nav.logout')}</button>
          <button
            data-testid="theme-toggle"
            class={styles.authBarBtn}
            onClick={handleToggle}
            title={isLight() ? t('theme.switchDark') : t('theme.switchLight')}
            aria-label={isLight() ? t('theme.switchDark') : t('theme.switchLight')}
          >
            {isLight() ? '☀' : '☾'}
          </button>
        </div>
      </Show>
      {props.children as any}
    </>
  );
};

export default AppRoot;
