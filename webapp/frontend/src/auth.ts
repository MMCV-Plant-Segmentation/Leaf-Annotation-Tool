import { createSignal } from 'solid-js';

export type User = { id: number; username: string; is_admin: boolean };

// Module-level signal shared across all Solid render trees on the page.
export const [currentUser, setCurrentUser] = createSignal<User | null | undefined>(undefined);

export async function fetchMe(): Promise<User | null> {
  const res = await fetch('/api/me');
  if (!res.ok) return null;
  const data = await res.json() as User | null;
  setCurrentUser(data);
  return data;
}

export async function logout(): Promise<void> {
  await fetch('/api/logout', { method: 'POST' });
  setCurrentUser(null);
  window.location.href = '/login';
}
