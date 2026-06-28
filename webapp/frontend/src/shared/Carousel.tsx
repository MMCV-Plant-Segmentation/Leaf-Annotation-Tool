/**
 * Minimal, project-agnostic carousel: cycle one item at a time with prev/next.
 *
 * No deps (Kobalte has no carousel). Manages its own index, wraps around the ends,
 * and renders the current item via a render-prop. A caption row (e.g. a file path)
 * is always shown when `caption` is provided. Reuse candidate — see the someday
 * reusable-component-library doc.
 */
import { type JSX, createSignal, createMemo, Show } from 'solid-js';
import * as styles from './Carousel.css';

type Props<T> = {
  items: T[];
  children: (item: T, index: number) => JSX.Element;
  caption?: (item: T, index: number) => string;
  labelPrev?: string;
  labelNext?: string;
};

function Carousel<T>(props: Props<T>): JSX.Element {
  const [index, setIndex] = createSignal(0);

  // Keep the index in range if the items array shrinks.
  const safeIndex = createMemo(() => {
    const n = props.items.length;
    if (n === 0) return 0;
    return ((index() % n) + n) % n;
  });
  const current = createMemo<T | undefined>(() => props.items[safeIndex()]);

  const step = (delta: number) => {
    const n = props.items.length;
    if (n === 0) return;
    setIndex((safeIndex() + delta + n) % n);
  };

  return (
    <Show when={props.items.length > 0}>
      <div class={styles.wrap}>
        <div class={styles.controls}>
          <button
            class={styles.navBtn}
            data-testid="carousel-prev"
            onClick={() => step(-1)}
            aria-label={props.labelPrev ?? 'Previous'}
          >‹</button>
          <span class={styles.counter} data-testid="carousel-counter">
            {safeIndex() + 1} / {props.items.length}
          </span>
          <button
            class={styles.navBtn}
            data-testid="carousel-next"
            onClick={() => step(1)}
            aria-label={props.labelNext ?? 'Next'}
          >›</button>
        </div>

        <Show when={props.caption}>
          <div class={styles.caption} data-testid="carousel-caption">
            {props.caption!(current()!, safeIndex())}
          </div>
        </Show>

        <div class={styles.stage} data-testid="carousel-stage">
          {props.children(current()!, safeIndex())}
        </div>
      </div>
    </Show>
  );
}

export default Carousel;
