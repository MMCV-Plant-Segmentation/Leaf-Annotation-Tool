/**
 * Responsive thumbnail grid that fills the available width with larger thumbnails,
 * VIRTUALIZED (windowed) so a project with hundreds/thousands of images stays
 * responsive: only the rows currently scrolled into view (+ a small overscan) get a
 * DOM node — the rest are represented purely by top/bottom spacer padding on the
 * scrollable `<ul>`, recycled as the user scrolls (see ./virtualGrid.ts for the pure
 * row/column math). Image BYTES are separately lazy-loaded on *scroll-settle*: an
 * IntersectionObserver feeds a debounced settle tracker (see lazyLoad.ts), so rapidly
 * scrolling past images doesn't fire a request per image — only those still visible
 * once the scroll stops are loaded. Click → onSelect.
 *
 * Project-agnostic: takes plain {key, src, label?, title?} items. Reuse candidate.
 */
import { type Component, For, createMemo, createSignal, onMount, onCleanup } from 'solid-js';
import { createSettleTracker } from './lazyLoad';
import { computeColumns, computeWindow } from './virtualGrid';
import * as styles from './LazyImageGrid.css';

export type LazyImageItem = { key: string; src: string; label?: string; title?: string };

type Props = {
  items: LazyImageItem[];
  onSelect?: (key: string) => void;
  selectedKey?: string | null;
};

// 1×1 transparent GIF — shown until a cell settles into view, so no eager request fires.
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

// Layout constants mirroring LazyImageGrid.css.ts's `grid`/`cell` rules (kept in sync by
// hand — Vanilla Extract classes aren't introspectable at runtime). A drift here only
// mis-sizes the virtualization window slightly; OVERSCAN_ROWS absorbs small drift.
const MIN_CELL_PX = 150;
const GAP_PX = 12;             // 0.75rem
const GRID_PADDING_PX = 8;     // 4px * 2 sides
const OVERSCAN_ROWS = 2;
const ROW_HEIGHT_FALLBACK = 168; // used only before the probe cell has been measured

const LazyImageGrid: Component<Props> = (props) => {
  const [loaded, setLoaded] = createSignal<ReadonlySet<string>>(new Set());
  const tracker = createSettleTracker(setLoaded, 160);
  let rootRef: HTMLUListElement | undefined;
  let probeRef: HTMLDivElement | undefined;
  let observer: IntersectionObserver | undefined;

  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportH, setViewportH] = createSignal(0);
  const [contentW, setContentW] = createSignal(0);
  const [rowH, setRowH] = createSignal(ROW_HEIGHT_FALLBACK);

  onMount(() => {
    if (typeof IntersectionObserver === 'undefined') {
      setLoaded(new Set(props.items.map((i) => i.key)));   // no IO (tests/SSR): load all
    } else {
      observer = new IntersectionObserver((entries) => {
        for (const e of entries) {
          const key = (e.target as HTMLElement).dataset.key;
          if (key) tracker.setVisible(key, e.isIntersecting);
        }
      }, { root: rootRef, rootMargin: '150px' });
    }
    if (!rootRef) return;
    const syncGeometry = () => {
      setViewportH(rootRef!.clientHeight);
      setContentW(rootRef!.clientWidth - GRID_PADDING_PX);
      const h = probeRef?.getBoundingClientRect().height ?? 0;
      if (h > 0) setRowH(h + GAP_PX);
    };
    syncGeometry();
    const onScroll = () => setScrollTop(rootRef!.scrollTop);
    rootRef.addEventListener('scroll', onScroll, { passive: true });
    onCleanup(() => rootRef?.removeEventListener('scroll', onScroll));
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(syncGeometry);
      ro.observe(rootRef);
      onCleanup(() => ro.disconnect());
    }
  });
  onCleanup(() => { observer?.disconnect(); tracker.cancel(); });

  const refCell = (el: HTMLElement, key: string) => {
    el.dataset.key = key;
    observer?.observe(el);
    onCleanup(() => observer?.unobserve(el));
  };

  const columns = createMemo(() => computeColumns(contentW(), MIN_CELL_PX, GAP_PX));
  const win = createMemo(() => computeWindow(
    props.items.length, columns(), rowH(), scrollTop(), viewportH(), OVERSCAN_ROWS,
  ));
  const visible = createMemo(() => props.items.slice(win().startIndex, win().endIndex));

  return (
    <>
      {/* Off-screen probe (same cell markup, out of the grid's own flow) purely to
          MEASURE a real row's rendered height — independent of column width since the
          thumbnail height is fixed CSS, not aspect-ratio-derived. */}
      <div class={styles.cell} ref={probeRef} aria-hidden="true"
        style={{ position: 'fixed', top: '-9999px', left: '-9999px', visibility: 'hidden' }}>
        <img src={BLANK} alt="" /><span>&nbsp;</span>
      </div>
      <ul class={styles.grid} data-testid="lazy-image-grid" ref={rootRef}
        style={{ 'padding-top': `${win().padTop}px`, 'padding-bottom': `${win().padBottom}px` }}>
        <For each={visible()}>
          {(it) => (
            <li
              class={`${styles.cell} ${props.selectedKey === it.key ? styles.cellSel : ''}`}
              title={it.title ?? it.label ?? ''}
              ref={(el) => refCell(el, it.key)}
              onClick={() => props.onSelect?.(it.key)}
            >
              <img src={loaded().has(it.key) ? it.src : BLANK} alt={it.label ?? ''}
                loading="lazy" decoding="async" />
              <span>{it.label}</span>
            </li>
          )}
        </For>
      </ul>
    </>
  );
};

export default LazyImageGrid;
