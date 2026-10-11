/**
 * t85 — the in-app navigation-stack reconstruction that lets a canvas "Back" button pop the
 * page that pushed it, or fall back to a parent on a deep link. Pure module in
 * src/projects/inAppHistory.ts; AppRoot feeds it loc.pathname on every route change.
 */
import { test, expect } from '@playwright/test';

test.describe('inAppHistory', () => {
  test('a single (deep-linked) entry has nothing to go back to', async () => {
    const { recordVisit, canGoBack, resetInAppHistory } = await import('../../src/projects/inAppHistory');
    resetInAppHistory();
    recordVisit('/projects/p1/batches/b1');   // landed directly on the canvas
    expect(canGoBack()).toBe(false);
  });

  test('a forward navigation leaves an in-app page behind → can go back', async () => {
    const { recordVisit, canGoBack, resetInAppHistory } = await import('../../src/projects/inAppHistory');
    resetInAppHistory();
    recordVisit('/projects/p1');
    recordVisit('/projects/p1/batches/b1');
    expect(canGoBack()).toBe(true);
  });

  test('returning to the previous page pops it (a back navigation), not double-counts', async () => {
    const { recordVisit, canGoBack, resetInAppHistory } = await import('../../src/projects/inAppHistory');
    resetInAppHistory();
    recordVisit('/projects/p1');
    recordVisit('/projects/p1/batches/b1');
    recordVisit('/projects/p1');               // nav(-1) took us back to the hub
    expect(canGoBack()).toBe(false);           // hub is now the only entry
  });

  test('deeper forward chain stays poppable at each level', async () => {
    const { recordVisit, canGoBack, resetInAppHistory } = await import('../../src/projects/inAppHistory');
    resetInAppHistory();
    recordVisit('/projects/p1');
    recordVisit('/projects/p1/images');
    recordVisit('/projects/p1/batches/b1');    // reached the canvas via the images page
    expect(canGoBack()).toBe(true);            // Back should return to /images, not the hub
  });

  test('a repeated path (replace / no-op) does not grow the stack', async () => {
    const { recordVisit, canGoBack, resetInAppHistory } = await import('../../src/projects/inAppHistory');
    resetInAppHistory();
    recordVisit('/projects/p1/batches/b1');
    recordVisit('/projects/p1/batches/b1');
    expect(canGoBack()).toBe(false);
  });
});
