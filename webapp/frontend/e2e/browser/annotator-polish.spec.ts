/**
 * Annotator config POLISH — behavioural browser tests.
 *
 * Covers: delete-project (with confirm), per-step sub-routes + their locks, streaming
 * import progress bar, lazy/clamped image preview, and the tiling carousel + "Background"
 * relabel with its tooltip/unit.
 */
import { test, expect, type Page } from '@playwright/test';

// Server-side import path. The concurrency-safe gate seeds into a per-run temp dir and
// exports it via HT_E2E_FIXTURE_DIR; fall back to the fixed path for a plain test run.
const FIXTURE_DIR = process.env.HT_E2E_FIXTURE_DIR ?? '/tmp/leaf-e2e-fixture';
const FIXTURE_NESTED = `${FIXTURE_DIR}/nested-images`;

async function createProject(page: Page, name: string): Promise<string> {
  await page.goto('/projects');
  await page.fill('form input[type="text"]', name);
  await page.click('button:text("Create project")');
  await expect(page).toHaveURL(/\/projects\/[a-f0-9-]{36}/);
  return page.url().split('/projects/')[1].split('?')[0];
}

async function importImages(page: Page, pid: string) {
  await page.goto(`/projects/${pid}/images`);
  await page.fill('[data-testid="import-path"]', FIXTURE_NESTED);
  await page.click('button:text("Import")');
  await expect(page.getByTestId('import-summary')).toBeVisible({ timeout: 15000 });
}


// ── Delete project ─────────────────────────────────────────────────────────────

test('hub has a delete control that removes the project and returns to /projects', async ({ page }) => {
  const name = `Junk ${Date.now()}`;
  const pid = await createProject(page, name);
  await page.goto(`/projects/${pid}`);

  await page.getByTestId('delete-project').click();
  // Confirm step appears
  await page.getByTestId('delete-project-confirm').click();

  await expect(page).toHaveURL(/\/projects$/, { timeout: 5000 });
  // The project card is gone from the list
  await expect(page.getByText(name, { exact: true })).toHaveCount(0);
});


// ── Per-step sub-routes + locks ─────────────────────────────────────────────────

test('sub-routes render as separate pages', async ({ page }) => {
  const pid = await createProject(page, `Routes ${Date.now()}`);

  await page.goto(`/projects/${pid}/images`);
  await expect(page.getByTestId('import-path')).toBeVisible();

  // Tiling locked before any image
  await page.goto(`/projects/${pid}/tiling`);
  await expect(page.getByText(/import images first/i)).toBeVisible();

  // Batches locked before tiling confirmed
  await page.goto(`/projects/${pid}/batches`);
  await expect(page.getByText(/configure tiling first/i)).toBeVisible();
});

test('tiling route unlocks after import; batches route after tiling', async ({ page }) => {
  const pid = await createProject(page, `Gate ${Date.now()}`);
  await importImages(page, pid);

  // Tiling route now shows the controls (Background label), not the lock
  await page.goto(`/projects/${pid}/tiling`);
  await expect(page.getByText(/import images first/i)).toHaveCount(0);
  await expect(page.getByTestId('background-slider')).toBeVisible();

  // Batches still locked until tiling saved
  await page.goto(`/projects/${pid}/batches`);
  await expect(page.getByText(/configure tiling first/i)).toBeVisible();

  // Save tiling, then batches route unlocks
  await page.goto(`/projects/${pid}/tiling`);
  await page.getByRole('button', { name: /save.*default/i }).click();
  await page.goto(`/projects/${pid}/batches`);
  await expect(page.getByText(/configure tiling first/i)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /create batch/i })).toBeVisible();
});


// ── Streaming import progress bar ───────────────────────────────────────────────

test('import shows a progress bar and a final count', async ({ page }) => {
  const pid = await createProject(page, `Progress ${Date.now()}`);
  await page.goto(`/projects/${pid}/images`);
  await page.fill('[data-testid="import-path"]', FIXTURE_NESTED);
  await page.click('button:text("Import")');

  // Progress UI appears and resolves to the full count (fixture has 3 images)
  await expect(page.getByTestId('import-progress')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('import-progress-label')).toContainText('3 / 3', { timeout: 15000 });
  await expect(page.getByTestId('import-summary')).toContainText(/Imported 3/i);
});


// ── Lazy / clamped image preview ────────────────────────────────────────────────

test('image preview is a clamped scrollable grid with lazy thumbnails', async ({ page }) => {
  const pid = await createProject(page, `Lazy ${Date.now()}`);
  await importImages(page, pid);

  const grid = page.getByTestId('lazy-image-grid');
  await expect(grid).toBeVisible();
  // Thumbnails use native lazy loading (in addition to the JS scroll-settle gate)
  await expect(grid.locator('img').first()).toHaveAttribute('loading', 'lazy');
});

test('image preview grid is height-clamped @full', async ({ page }, testInfo) => {
  if (testInfo.project.name !== 'full') return;
  const pid = await createProject(page, `LazyFull ${Date.now()}`);
  await importImages(page, pid);

  const grid = page.getByTestId('lazy-image-grid');
  const maxH = await grid.evaluate((el) => getComputedStyle(el).maxHeight);
  // A concrete clamp (e.g. 460px), never 'none' — proves the list won't flood the page.
  expect(maxH).not.toBe('none');
  expect(maxH).toMatch(/\d+px/);
});


// ── Click-to-enlarge lightbox ───────────────────────────────────────────────────

test('clicking an imported thumbnail opens a lightbox and closes again', async ({ page }) => {
  const pid = await createProject(page, `Box ${Date.now()}`);
  await importImages(page, pid);

  const grid = page.getByTestId('lazy-image-grid');
  await grid.locator('li').first().click();

  await expect(page.getByTestId('lightbox')).toBeVisible();
  await expect(page.getByTestId('lightbox-image')).toBeVisible();

  // Escape closes it
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('lightbox')).toHaveCount(0);
});


// ── Tiling carousel + MLT relabel + lightbox + save confirm ──────────────────────

test('tiling renders a carousel whose prev/next change the shown path', async ({ page }) => {
  const pid = await createProject(page, `Carousel ${Date.now()}`);
  await importImages(page, pid);
  await page.goto(`/projects/${pid}/tiling`);

  const caption = page.getByTestId('carousel-caption');
  await expect(caption).toBeVisible();
  const first = await caption.textContent();

  await page.getByTestId('carousel-next').click();
  await expect(caption).not.toHaveText(first ?? '');

  await page.getByTestId('carousel-prev').click();
  await expect(caption).toHaveText(first ?? '');
});

test('tiling shows the MLT label with unit and a click-openable popover', async ({ page }) => {
  const pid = await createProject(page, `MLT ${Date.now()}`);
  await importImages(page, pid);
  await page.goto(`/projects/${pid}/tiling`);

  await expect(page.getByTestId('mlt-label')).toContainText('Minimum Luminance Threshold (MLT)');
  // Unit shown (luminance 0–255)
  await expect(page.getByText(/luminance.*0.*255/i)).toBeVisible();

  // The explanation is hidden until the info affordance is CLICKED (not hover-only)
  await expect(page.getByTestId('mlt-popover')).toHaveCount(0);
  await page.getByTestId('mlt-info').click();
  await expect(page.getByTestId('mlt-popover')).toBeVisible();
  await expect(page.getByTestId('mlt-popover')).toContainText(/brighter than this count as leaf/i);
});

test('clicking the tiling preview opens the lightbox', async ({ page }) => {
  const pid = await createProject(page, `TileBox ${Date.now()}`);
  await importImages(page, pid);
  await page.goto(`/projects/${pid}/tiling`);

  await page.getByTestId('tile-preview-enlarge').click();
  await expect(page.getByTestId('lightbox-image')).toBeVisible();
  await expect(page.getByTestId('lightbox-caption')).toBeVisible();
});

test('saving the tiling default shows "Saved" and persists on reload', async ({ page }) => {
  const pid = await createProject(page, `Save ${Date.now()}`);
  await importImages(page, pid);
  await page.goto(`/projects/${pid}/tiling`);

  // Move the MLT slider to a distinct value, then save
  await page.getByTestId('background-slider').fill('77');
  await page.getByRole('button', { name: /save.*default/i }).click();

  // Visible confirmation
  await expect(page.getByTestId('save-confirm')).toBeVisible();

  // Round-trips on reload
  await page.reload();
  await expect(page.getByText(/luminance 77/i)).toBeVisible();
});

// Rapidly moving the threshold slider must NOT fire one /preview request per step; the
// readout updates live, but the fetch is debounced and lands on the FINAL value.
test('rapid threshold changes are debounced into a final preview request', async ({ page }) => {
  const pid = await createProject(page, `Debounce ${Date.now()}`);
  await importImages(page, pid);

  const previewUrls: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes('/tiles/preview')) previewUrls.push(req.url());
  });

  await page.goto(`/projects/${pid}/tiling`);
  // Wait for the initial preview to land so we count only the burst that follows.
  await expect(page.getByTestId('survive-count').first()).toBeVisible();
  const before = previewUrls.length;

  // Five quick slider moves ending on 200.
  const slider = page.getByTestId('background-slider');
  for (const v of ['40', '80', '120', '160', '200']) await slider.fill(v);

  // The readout reflects the final value immediately (live, not debounced).
  await expect(page.getByText(/luminance 200/i)).toBeVisible();

  // After the settle, the LAST preview request used the final threshold…
  await expect.poll(() => previewUrls.at(-1) ?? '').toContain('black_threshold=200');
  // …and the burst collapsed to far fewer requests than the 5 inputs (debounced).
  expect(previewUrls.length - before).toBeLessThan(5);
});


// ── Polish 3 ─────────────────────────────────────────────────────────────────

test('images grid is multi-column at a wide viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const pid = await createProject(page, `Wide ${Date.now()}`);
  await importImages(page, pid);   // fixture has 3 nested images

  const cells = page.getByTestId('lazy-image-grid').locator('li');
  await expect(cells).toHaveCount(3);
  // In a true multi-column grid the 3 thumbnails share the top row (same y).
  const ys = await cells.evaluateAll((els) =>
    els.map((el) => Math.round(el.getBoundingClientRect().top)));
  const topRow = ys.filter((y) => y === ys[0]).length;
  expect(topRow).toBeGreaterThanOrEqual(3);   // ≥3 per row → fails on one-per-row
});

test('a new project defaults the MLT to luminance 0', async ({ page }) => {
  const pid = await createProject(page, `Zero ${Date.now()}`);
  await importImages(page, pid);
  await page.goto(`/projects/${pid}/tiling`);
  // The MLT control's value label reads luminance 0 by default.
  await expect(page.getByText(/luminance 0\b/i)).toBeVisible();
});

test('tiling lightbox keeps the SVG tile overlay over the enlarged image', async ({ page }) => {
  const pid = await createProject(page, `Overlay ${Date.now()}`);
  await importImages(page, pid);
  await page.goto(`/projects/${pid}/tiling`);

  await page.getByTestId('tile-preview-enlarge').click();
  await expect(page.getByTestId('lightbox-image')).toBeVisible();

  // The tile overlay SVG is present in the lightbox with ≥1 tile rect.
  const overlay = page.getByTestId('lightbox-tile-overlay');
  await expect(overlay).toBeVisible();
  expect(await overlay.locator('rect').count()).toBeGreaterThan(0);
});

// Replaces the old crop-swap test: clicking a tile now zooms/centres the viewport
// onto that tile without cropping — the overlay stays, and the selected tile is highlighted.
test('clicking a tile zooms and highlights it; overlay stays (replaces crop-swap)', async ({ page }) => {
  const pid = await createProject(page, `TileZoom ${Date.now()}`);
  await importImages(page, pid);
  await page.goto(`/projects/${pid}/tiling`);

  await page.getByTestId('tile-preview-enlarge').click();
  const overlay = page.getByTestId('lightbox-tile-overlay');
  await expect(overlay).toBeVisible();

  // Click first tile → overlay still present (not replaced by a bare crop)
  await overlay.locator('rect').first().click();
  await expect(page.getByTestId('lightbox-tile-overlay')).toBeVisible();
  // Selected tile is highlighted with a data-selected rect
  await expect(overlay.locator('[data-selected="true"]')).toHaveCount(1);
  // The non-selected grid rects are hidden — only the selected box remains.
  await expect(overlay.locator('rect:not([data-selected])')).toHaveCount(0);
  await expect(overlay.locator('rect')).toHaveCount(1);
  // Full image still visible (surrounding leaf visible — not a bare crop)
  await expect(page.getByTestId('lightbox-image')).toBeVisible();
});

// A drag that starts on a tile rect must PAN, not select/zoom that tile.
test('dragging across the tiling lightbox pans without selecting a tile', async ({ page }) => {
  const pid = await createProject(page, `Pan ${Date.now()}`);
  await importImages(page, pid);
  await page.goto(`/projects/${pid}/tiling`);

  await page.getByTestId('tile-preview-enlarge').click();
  const overlay = page.getByTestId('lightbox-tile-overlay');
  await expect(overlay).toBeVisible();
  const gridCount = await overlay.locator('rect').count();

  // Press on a tile rect, move well past the drag threshold, release.
  const box = await overlay.locator('rect').first().boundingBox();
  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 40, cy + 40, { steps: 8 });
  await page.mouse.move(cx + 80, cy + 80, { steps: 8 });
  await page.mouse.up();

  // No tile selected (the drag was a pan): no highlight, full grid still shown.
  await expect(overlay.locator('[data-selected="true"]')).toHaveCount(0);
  expect(await overlay.locator('rect').count()).toBe(gridCount);
});

test('hovering a tile fills it translucently (hover highlight) @full', async ({ page }, testInfo) => {
  if (testInfo.project.name !== 'full') return;
  const pid = await createProject(page, `Hover ${Date.now()}`);
  await importImages(page, pid);
  await page.goto(`/projects/${pid}/tiling`);

  await page.getByTestId('tile-preview-enlarge').click();
  const overlay = page.getByTestId('lightbox-tile-overlay');
  await expect(overlay).toBeVisible();

  const rect = overlay.locator('rect').first();
  // Move the cursor off the grid first so the baseline fill is the un-hovered value
  // (the enlarge-click can leave the pointer sitting on a tile).
  await page.mouse.move(0, 0);
  const fillBefore = await rect.evaluate((el) => getComputedStyle(el).fill);
  await rect.hover();
  const fillHover = await rect.evaluate((el) => getComputedStyle(el).fill);
  // Hover adds a translucent fill (transparent → a resolved color).
  expect(fillHover).not.toBe(fillBefore);
});

test('tile rects render with a transparent fill (outlines only)', async ({ page }) => {
  const pid = await createProject(page, `Fill ${Date.now()}`);
  await importImages(page, pid);
  await page.goto(`/projects/${pid}/tiling`);

  await page.getByTestId('tile-preview-enlarge').click();
  const overlay = page.getByTestId('lightbox-tile-overlay');
  await expect(overlay).toBeVisible();

  const rect = overlay.locator('rect').first();
  // Transparent fill (attribute set to literal "transparent"); stroke stays colored.
  await expect(rect).toHaveAttribute('fill', 'transparent');
});

test('wheel zoom changes the viewport scale in the lightbox @full', async ({ page }, testInfo) => {
  if (testInfo.project.name !== 'full') return;
  const pid = await createProject(page, `WheelScale ${Date.now()}`);
  await importImages(page, pid);
  await page.goto(`/projects/${pid}/tiling`);

  await page.getByTestId('tile-preview-enlarge').click();
  await expect(page.getByTestId('lightbox-image')).toBeVisible();

  const canvas = page.getByTestId('zoom-pan-canvas');
  const getScale = () => canvas.evaluate((el: HTMLElement) => {
    const m = el.style.transform.match(/scale\(([^,)]+)\)/);
    return m ? parseFloat(m[1]) : null;
  });
  const initialScale = await getScale();

  await page.getByTestId('lightbox').hover();
  await page.mouse.wheel(0, -300);  // negative deltaY = zoom in

  const newScale = await getScale();
  expect(newScale).not.toBeNull();
  expect(newScale!).toBeGreaterThan(initialScale ?? 0);
});

test('tile overlay stays aligned after wheel zoom', async ({ page }) => {
  const pid = await createProject(page, `ZoomAlign ${Date.now()}`);
  await importImages(page, pid);
  await page.goto(`/projects/${pid}/tiling`);

  await page.getByTestId('tile-preview-enlarge').click();
  const overlay = page.getByTestId('lightbox-tile-overlay');
  await expect(overlay).toBeVisible();
  const initialCount = await overlay.locator('rect').count();

  await page.getByTestId('lightbox').hover();
  await page.mouse.wheel(0, -300);

  // Overlay still present with same number of tile rects
  await expect(page.getByTestId('lightbox-tile-overlay')).toBeVisible();
  expect(await overlay.locator('rect').count()).toBe(initialCount);
});
