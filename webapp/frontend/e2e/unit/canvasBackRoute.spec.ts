/**
 * t85 — the annotator / merge canvas "Back" button returns to whatever page pushed the user
 * here (nav(-1)) when there is in-app history, and only falls back to the project hub on a
 * deep-linked / fresh load with nothing to pop.
 */
import { test, expect } from '@playwright/test';

test.describe('goBack', () => {
  test('pops the browser history when an in-app page is behind us', async () => {
    const { recordVisit, resetInAppHistory } = await import('../../src/projects/inAppHistory');
    const { goBack } = await import('../../src/projects/canvasBackRoute');
    resetInAppHistory();
    recordVisit('/projects/p1');
    recordVisit('/projects/p1/batches/b1');    // hub → canvas
    const calls: unknown[] = [];
    const nav = ((arg: unknown) => calls.push(arg)) as never;
    goBack(nav, '/projects/p1');
    expect(calls).toEqual([-1]);               // popped, did not push the fallback
  });

  test('navigates to the fallback on a deep link (no in-app history)', async () => {
    const { recordVisit, resetInAppHistory } = await import('../../src/projects/inAppHistory');
    const { goBack } = await import('../../src/projects/canvasBackRoute');
    resetInAppHistory();
    recordVisit('/projects/p1/batches/b1');    // landed directly on the canvas
    const calls: unknown[] = [];
    const nav = ((arg: unknown) => calls.push(arg)) as never;
    goBack(nav, '/projects/p1');
    expect(calls).toEqual(['/projects/p1']);   // fell back to the hub, not nav(-1)
  });
});

test.describe('projectHubRoute', () => {
  test('returns the project hub path for a project id', async () => {
    const { projectHubRoute } = await import('../../src/projects/canvasBackRoute');
    const pid = 'a3c9a018-0000-4000-8000-000000000000';
    expect(projectHubRoute(pid)).toBe(`/projects/${pid}`);
  });

  test('is an absolute in-app route (deep-link safe — not a relative/history jump)', async () => {
    const { projectHubRoute } = await import('../../src/projects/canvasBackRoute');
    const route = projectHubRoute('pid123');
    expect(route.startsWith('/projects/')).toBe(true);
    expect(route).not.toContain('..');
  });

  test('falls back to the projects list when the id is missing', async () => {
    const { projectHubRoute } = await import('../../src/projects/canvasBackRoute');
    expect(projectHubRoute(undefined)).toBe('/projects');
  });
});
