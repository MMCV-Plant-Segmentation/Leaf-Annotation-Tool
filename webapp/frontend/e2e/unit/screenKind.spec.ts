/**
 * t110 — the static-shell card width is decided by ONE route→screen-kind mapping, not by each
 * screen remembering to tag itself.
 *
 * The footgun this kills: the Solid routes render into `.setup-card`, which defaults to the
 * narrow ~420px login card and only widens via `.setup-card:has([data-screen="project"])`.
 * Historically every project route had to set that attribute by hand, so a NEW or SPLIT route
 * silently regressed to the narrow card — it has bitten four times (canvas a3c9a018, project
 * screens fff4a689, labels ebe8b462 → t107 1c9be587, and merge-canvas which matches no rule
 * at all). Deriving the kind from the PATH means a new route cannot forget.
 */
import { test, expect } from '@playwright/test';

test.describe('screenKindFor — project routes', () => {
  test('the project hub is a project screen', async () => {
    const { screenKindFor } = await import('../../src/nav/screenKind');
    expect(screenKindFor('/projects/p1')).toBe('project');
  });

  test('every known project config sub-route is a project screen', async () => {
    const { screenKindFor } = await import('../../src/nav/screenKind');
    for (const path of ['/projects/p1/images', '/projects/p1/tiling', '/projects/p1/labels']) {
      expect(screenKindFor(path)).toBe('project');
    }
  });

  test('THE REGRESSION GUARD: an unknown//future project sub-route defaults to project', async () => {
    // This is the whole point of t110 — a route nobody has written yet must inherit the wide
    // card rather than silently falling back to the narrow login card.
    const { screenKindFor } = await import('../../src/nav/screenKind');
    expect(screenKindFor('/projects/p1/trainer')).toBe('project');
    expect(screenKindFor('/projects/p1/some/deep/new/screen')).toBe('project');
  });
});

test.describe('screenKindFor — canvas routes keep their own kinds', () => {
  test('the annotator canvas is a canvas screen', async () => {
    const { screenKindFor } = await import('../../src/nav/screenKind');
    expect(screenKindFor('/projects/p1/batches/b1')).toBe('canvas');
  });

  test('the merge canvas is a merge-canvas screen (NOT a plain project screen)', async () => {
    const { screenKindFor } = await import('../../src/nav/screenKind');
    expect(screenKindFor('/projects/p1/batches/b1/merge')).toBe('merge-canvas');
  });

  test('the canvas kinds win over the project default despite the /projects prefix', async () => {
    const { screenKindFor } = await import('../../src/nav/screenKind');
    expect(screenKindFor('/projects/p1/batches/b1')).not.toBe('project');
    expect(screenKindFor('/projects/p1/batches/b1/merge')).not.toBe('project');
  });
});

test.describe('screenKindFor — non-project routes stay untagged (narrow card)', () => {
  test('the projects LIST keeps its current narrow-card behaviour', async () => {
    // Behaviour-preserving: /projects never set data-screen, so it must stay untagged.
    // Whether the list SHOULD be wide is a UX call for Christian, not this refactor.
    const { screenKindFor } = await import('../../src/nav/screenKind');
    expect(screenKindFor('/projects')).toBe(null);
  });

  test('login / home / admin / account are untagged', async () => {
    const { screenKindFor } = await import('../../src/nav/screenKind');
    for (const path of ['/', '/login', '/admin', '/account', '/manage', '/analyze']) {
      expect(screenKindFor(path)).toBe(null);
    }
  });

  test('a path that merely mentions projects is not a project route', async () => {
    const { screenKindFor } = await import('../../src/nav/screenKind');
    expect(screenKindFor('/projectsomething')).toBe(null);
  });
});

test.describe('screenKindFor — tolerant of real-world paths', () => {
  test('a trailing slash does not change the kind', async () => {
    const { screenKindFor } = await import('../../src/nav/screenKind');
    expect(screenKindFor('/projects/p1/')).toBe('project');
    expect(screenKindFor('/projects/')).toBe(null);
  });

  test('is a pure function of the path (no DOM, no router)', async () => {
    const { screenKindFor } = await import('../../src/nav/screenKind');
    expect(screenKindFor('/projects/p1')).toBe(screenKindFor('/projects/p1'));
  });
});
