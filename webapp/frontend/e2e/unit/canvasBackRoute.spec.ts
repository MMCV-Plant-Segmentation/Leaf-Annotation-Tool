/**
 * t85 — the annotator / merge canvas "Back" button must not use browser-history back
 * (`nav(-1)`), which dead-ends on a pasted / deep-linked canvas URL. It navigates to the
 * project hub, a route that always exists as the parent of a batch canvas.
 */
import { test, expect } from '@playwright/test';

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
