/**
 * Pure windowing math for a CSS `grid-template-columns: repeat(auto-fill, minmax(min,1fr))`
 * layout: reproduces the browser's auto-fill column count from a measured content width,
 * then turns a scroll position into the row range to render (+ overscan). A caller uses
 * this to mount DOM nodes ONLY for the visible window instead of the whole item list —
 * a project with thousands of images stays interactive because the DOM node count is
 * bounded by the viewport, not by the item count.
 *
 * Framework-free and side-effect-free so the row/column math is unit-testable without a
 * browser DOM (see e2e/unit/virtual-grid.spec.ts).
 */

/** How many `auto-fill` columns fit `contentWidth` given each track's minimum width and
 * the inter-track gap — mirrors the browser's own auto-fill column count. */
export function computeColumns(contentWidth: number, minCell: number, gap: number): number {
  if (contentWidth <= 0 || minCell <= 0) return 1;
  const n = Math.floor((contentWidth + gap) / (minCell + gap));
  return Math.max(1, n);
}

export type WindowGeometry = {
  /** First item index to render (inclusive). */
  startIndex: number;
  /** Last item index to render (exclusive). */
  endIndex: number;
  /** Spacer height (px) to reserve ABOVE the rendered items, standing in for hidden rows. */
  padTop: number;
  /** Spacer height (px) to reserve BELOW the rendered items. */
  padBottom: number;
};

/**
 * The item-index window (+ its spacer heights) that should be mounted for a scrollable
 * region `viewportH` tall, scrolled to `scrollTop`, given a fixed `rowHeight` (px, gap
 * included) and `columns` items per row. `overscanRows` extra rows are kept mounted on
 * each side of the visible range so a small scroll doesn't pop new DOM nodes in visibly.
 *
 * Degrades to "render everything, no spacers" when geometry isn't known yet (rowHeight
 * or columns <= 0) — the safe state before the first layout measurement lands.
 */
export function computeWindow(
  itemCount: number,
  columns: number,
  rowHeight: number,
  scrollTop: number,
  viewportH: number,
  overscanRows: number,
): WindowGeometry {
  if (itemCount === 0 || columns <= 0 || rowHeight <= 0) {
    return { startIndex: 0, endIndex: itemCount, padTop: 0, padBottom: 0 };
  }
  const totalRows = Math.ceil(itemCount / columns);
  const startRow = Math.max(0, Math.floor(scrollTop / rowHeight) - overscanRows);
  const endRow = Math.min(totalRows, Math.ceil((scrollTop + viewportH) / rowHeight) + overscanRows);
  return {
    startIndex: startRow * columns,
    endIndex: Math.min(itemCount, endRow * columns),
    padTop: startRow * rowHeight,
    padBottom: (totalRows - endRow) * rowHeight,
  };
}
