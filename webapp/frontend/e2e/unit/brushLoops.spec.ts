/**
 * Live brush LOOP FILL (Christian 2026-10-11: "the pen tool no longer does the live
 * intersection-checking/filling it used to"). brushLoops.ts finds where the brush band comes
 * back onto earlier ink and yields the loop to fill — pure, no engine.
 */
import { test, expect } from '@playwright/test';

const MOD = '../../src/projects/brushLoops';
const SIZE = 10;  // brush diameter

const area = (r: number[][]) => Math.abs(r.reduce((s, p, i) => {
  const q = r[(i + 1) % r.length]; return s + p[0] * q[1] - q[0] * p[1];
}, 0)) / 2;
const circle = (cx: number, cy: number, rad: number, turns: number, step: number) => {
  const n = Math.ceil((2 * Math.PI * rad * turns) / step);
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = (i / n) * 2 * Math.PI * turns; return [cx + rad * Math.cos(a), cy + rad * Math.sin(a)];
  });
};

test.describe('brushLoops', () => {
  test('a stroke that closes on itself yields ONE loop covering the enclosed area', async () => {
    const { createLoopFinder } = await import(MOD);
    const f = createLoopFinder(); f.reset(SIZE);
    for (const p of circle(100, 100, 40, 1.15, 6)) f.add(p);   // a bit past closing
    expect(f.loops()).toHaveLength(1);
    // The loop's polygon covers (about) the whole circle, not a sliver.
    expect(area(f.loops()[0])).toBeGreaterThan(0.85 * Math.PI * 40 * 40);
  });

  test('the pen closing a loop shows it LIVE, before it is frozen', async () => {
    const { createLoopFinder } = await import(MOD);
    const f = createLoopFinder(); f.reset(SIZE);
    const pts = circle(100, 100, 40, 1, 6);
    for (const p of pts.slice(0, -3)) f.add(p);       // frozen up to just short of closing
    expect(f.loops()).toHaveLength(0);
    expect(f.live(pts.slice(-3))).not.toBeNull();     // the provisional tail touches the start
    expect(f.live([[100, 300]])).toBeNull();          // a tail far from earlier ink closes nothing
  });

  test('no loop for a straight line, a wide U, or a band that never touches itself', async () => {
    const { createLoopFinder } = await import(MOD);
    const line = createLoopFinder(); line.reset(SIZE);
    for (let x = 0; x <= 200; x += 6) line.add([x, 0]);
    expect(line.loops()).toHaveLength(0);
    // A U whose legs are 3 diameters apart — the bands never touch.
    const u = createLoopFinder(); u.reset(SIZE);
    for (let y = 0; y <= 100; y += 6) u.add([0, y]);
    for (let x = 0; x <= 30; x += 6) u.add([x, 100]);
    for (let y = 100; y >= 0; y -= 6) u.add([30, y]);
    expect(u.loops()).toHaveLength(0);
  });

  test('a figure-8 makes two loops; reset() forgets the previous stroke', async () => {
    const { createLoopFinder } = await import(MOD);
    const f = createLoopFinder(); f.reset(SIZE);
    for (const p of circle(100, 100, 30, 1.1, 6)) f.add(p);
    for (const p of circle(160, 100, 30, 1.1, 6).map(([x, y]) => [x, y])) f.add(p);
    expect(f.loops().length).toBeGreaterThanOrEqual(2);
    f.reset(SIZE);
    expect(f.loops()).toHaveLength(0);
  });
});
