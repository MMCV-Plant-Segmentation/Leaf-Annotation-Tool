import { type Component, createEffect, Show } from 'solid-js';
import { useLocation, useNavigate } from '@solidjs/router';
import type { RouteSectionProps } from '@solidjs/router';
import { currentUser, fetchMe, logout } from '../auth';
import styles from './AppRoot.module.css';

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
  });

  const isPublic = () =>
    PUBLIC_ROUTES.has(loc.pathname) || loc.pathname.startsWith('/invite/');

  return (
    <>
      <Show when={currentUser() && !isPublic()}>
        <div class={styles.authBar}>
          <span>{currentUser()!.username}</span>
          <Show when={currentUser()!.is_admin}>
            <button onClick={() => nav('/admin')}>Admin</button>
          </Show>
          <button onClick={() => void logout()}>Log out</button>
        </div>
      </Show>
      {props.children as any}
    </>
  );
};

export default AppRoot;
