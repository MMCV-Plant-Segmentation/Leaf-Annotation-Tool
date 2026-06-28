/**
 * Responsive thumbnail grid that fills the available width with larger thumbnails and
 * lazy-loads images on *scroll-settle*: an IntersectionObserver feeds a debounced settle
 * tracker (see lazyLoad.ts), so rapidly scrolling past images doesn't fire a request per
 * image — only those still visible once the scroll stops are loaded. Click → onSelect.
 *
 * Project-agnostic: takes plain {key, src, label?, title?} items. Reuse candidate.
 */
import { type Component, For, createSignal, onMount, onCleanup } from 'solid-js';
import { createSettleTracker } from './lazyLoad';
import * as styles from './LazyImageGrid.css';

export type LazyImageItem = { key: string; src: string; label?: string; title?: string };

type Props = {
  items: LazyImageItem[];
  onSelect?: (key: string) => void;
  selectedKey?: string | null;
};

// 1×1 transparent GIF — shown until a cell settles into view, so no eager request fires.
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

const LazyImageGrid: Component<Props> = (props) => {
  const [loaded, setLoaded] = createSignal<ReadonlySet<string>>(new Set());
  const tracker = createSettleTracker(setLoaded, 160);
  const cells: HTMLElement[] = [];
  let rootRef: HTMLUListElement | undefined;
  let observer: IntersectionObserver | undefined;

  onMount(() => {
    if (typeof IntersectionObserver === 'undefined') {
      setLoaded(new Set(props.items.map((i) => i.key)));   // no IO (tests/SSR): load all
      return;
    }
    observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const key = (e.target as HTMLElement).dataset.key;
        if (key) tracker.setVisible(key, e.isIntersecting);
      }
    }, { root: rootRef, rootMargin: '150px' });
    for (const el of cells) observer.observe(el);
  });
  onCleanup(() => { observer?.disconnect(); tracker.cancel(); });

  const refCell = (el: HTMLElement, key: string) => {
    el.dataset.key = key;
    cells.push(el);
    observer?.observe(el);   // observe late-added cells (e.g. after a new import)
  };

  return (
    <ul class={styles.grid} data-testid="lazy-image-grid" ref={rootRef}>
      <For each={props.items}>
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
  );
};

export default LazyImageGrid;
