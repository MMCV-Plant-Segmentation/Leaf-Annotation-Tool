// BUGS #15: resolves which annotator's work the canvas displays.
//
// Non-admin: always the logged-in user (unchanged legacy behaviour — no picker).
// Admin: a READ-ONLY pick from the project's roster (the backend already blinds
// annotations/tile-state to the requested `annotator` query param, so no
// new endpoint is needed). Default = the first roster annotator with any
// annotations on the current image, else the first in the roster; the pick then
// persists as the admin navigates images (see createEffect guard below).
import { createEffect, createMemo, createResource, createSignal } from 'solid-js';
import type { Accessor } from 'solid-js';
import { currentUser } from '../auth';
import { projectsApi } from './api';

export type AnnotatorSelect = {
  annotator: Accessor<string>;
  isAdmin: Accessor<boolean>;
  roster: Accessor<string[]>;
  select: (byline: string) => void;
};

export function createAnnotatorSelect(
  projectId: Accessor<string | undefined>,
  batchId: Accessor<string | undefined>,
  imageId: Accessor<string | undefined>,
): AnnotatorSelect {
  const isAdmin = () => currentUser()?.is_admin ?? false;
  const [rosterRes] = createResource(
    () => (isAdmin() && projectId()) ? projectId() : undefined,
    async (pid: string) => (await projectsApi.get(pid)).annotators.map((a) => a.byline),
  );
  const roster = createMemo(() => rosterRes() ?? []);
  const [picked, setPicked] = createSignal<string | undefined>(undefined);

  // Runs once per batch open (guarded by `tried`); a manual pick (or a completed
  // probe) short-circuits it for the rest of the session on this canvas.
  let tried = false;
  createEffect(() => {
    const list = roster(); const bid = batchId(); const imgId = imageId();
    if (!isAdmin() || list.length < 2 || !bid || !imgId || tried || picked() !== undefined) return;
    tried = true;
    const initial = list[0];
    void pickDefault(bid, list, imgId).then((byline) => {
      if (byline !== initial && picked() === undefined) setPicked(byline);
    });
  });

  const annotator = () => isAdmin() ? (picked() ?? roster()[0] ?? '') : (currentUser()?.username ?? '');
  return { annotator, isAdmin, roster, select: setPicked };
}

/** Scan the roster in order for the first annotator with any annotations on
 * `imageId`; fall back to the first roster entry if none has any. */
async function pickDefault(batchId: string, roster: string[], imageId: string): Promise<string> {
  for (const byline of roster) {
    try {
      const cv = await projectsApi.batchCanvas(batchId, byline);
      const im = cv.images.find((x) => x.imageId === imageId);
      if (im && im.annotations.length > 0) return byline;
    } catch {
      // Probe failure — keep scanning; final fallback is roster[0] below.
    }
  }
  return roster[0];
}
