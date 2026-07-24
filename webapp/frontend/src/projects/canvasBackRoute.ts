// t85 — the annotator / merge canvas "Back" button. An in-app Back should return to whatever
// page sent the user here, popping the browser history when it matches; only a deep-link /
// fresh load (no in-app page behind us) falls back to a deterministic parent. `goBack` picks
// between those; `projectHubRoute` is the fallback (the project hub is always a valid parent of
// a batch canvas: `/projects/:id/batches/:batchId[/merge]`).
import { canGoBack } from './inAppHistory';

type Navigate = { (delta: number): void; (to: string): void };

export function goBack(nav: Navigate, fallback: string): void {
  if (canGoBack()) nav(-1);   // pop the in-app page that pushed us here
  else nav(fallback);         // deep-link / fresh load — no in-app history to pop
}

export function projectHubRoute(projectId: string | undefined): string {
  return projectId ? `/projects/${projectId}` : '/projects';
}
