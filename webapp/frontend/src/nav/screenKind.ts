/**
 * t110 — ONE route→screen-kind mapping for the static shell's card width.
 *
 * The Solid routes render into `.setup-card`, which defaults to the narrow ~420px login/home
 * card and only widens via `.setup-card:has([data-screen="project"])`. That attribute used to
 * be set by hand in every project screen's wrap, so a new or split route silently regressed to
 * the narrow card. Deriving the kind from the PATH means a route cannot forget: anything under
 * a project is a project screen unless it is explicitly one of the canvases.
 */

export type ScreenKind = 'project' | 'canvas' | 'merge-canvas';

const PROJECT_PREFIX = '/projects/';

/** The screen kind for a route path, or null for routes that keep the narrow card. */
export function screenKindFor(pathname: string): ScreenKind | null {
  const path = pathname.replace(/\/+$/, '');
  // `/projects` (the list) and lookalikes such as `/projectsomething` are NOT project screens.
  if (!path.startsWith(PROJECT_PREFIX)) return null;

  const [projectId, section, sectionId, subSection] = path.slice(PROJECT_PREFIX.length).split('/');
  if (!projectId) return null;

  // The canvases opt OUT of the project card — they strip the shell chrome themselves.
  if (section === 'batches' && sectionId) {
    return subSection === 'merge' ? 'merge-canvas' : 'canvas';
  }

  // Default: every other route under a project is a project screen. This is the t110 fix —
  // a future sub-route inherits the wide card instead of falling back to the login card.
  return 'project';
}
