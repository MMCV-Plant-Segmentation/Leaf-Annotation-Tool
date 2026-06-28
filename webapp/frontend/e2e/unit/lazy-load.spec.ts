/**
 * Unit tests for the scroll-settle lazy-load logic: a debounce coalesces rapid
 * visibility changes so only keys still visible when the scroll settles get loaded.
 */
import { test, expect } from '@playwright/test';
import { debounce, createSettleTracker } from '../../src/shared/lazyLoad';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test.describe('debounce', () => {
  test('only fires once after rapid calls', async () => {
    let calls = 0;
    const d = debounce(() => { calls += 1; }, 30);
    d(); d(); d(); d();
    expect(calls).toBe(0);          // nothing fired synchronously
    await wait(60);
    expect(calls).toBe(1);          // coalesced into a single trailing call
  });

  test('passes the latest args', async () => {
    let seen = '';
    const d = debounce((v: string) => { seen = v; }, 20);
    d('a'); d('b'); d('c');
    await wait(50);
    expect(seen).toBe('c');
  });

  test('cancel prevents the pending call', async () => {
    let calls = 0;
    const d = debounce(() => { calls += 1; }, 20);
    d();
    d.cancel();
    await wait(40);
    expect(calls).toBe(0);
  });
});

test.describe('createSettleTracker', () => {
  test('does not load keys that flash through before settling', async () => {
    const loads: string[][] = [];
    const tracker = createSettleTracker((loaded) => loads.push([...loaded]), 30);

    // "scroll past" img1 then img2 quickly (each becomes visible then hidden) and
    // settle on img3 — only img3 should be loaded.
    tracker.setVisible('img1', true);
    tracker.setVisible('img1', false);
    tracker.setVisible('img2', true);
    tracker.setVisible('img2', false);
    tracker.setVisible('img3', true);

    expect(loads).toHaveLength(0);   // nothing settled yet
    await wait(60);
    expect(loads).toHaveLength(1);
    expect(loads[0]).toEqual(['img3']);
  });

  test('accumulates loaded keys across settles', async () => {
    const loads: string[][] = [];
    const tracker = createSettleTracker((loaded) => loads.push([...loaded]), 20);

    tracker.setVisible('a', true);
    await wait(40);
    tracker.setVisible('b', true);
    await wait(40);

    expect(loads.at(-1)).toEqual(['a', 'b']);
  });
});
