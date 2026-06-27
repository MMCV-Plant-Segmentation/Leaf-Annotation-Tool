import { Component, For, createMemo } from 'solid-js';
import { hexToRgba } from '../analyze/lib/geometry';
import type { Mode } from '../analyze/lib/types';
import * as styles from './KBreakdown.css';

interface Props {
  mTotal: number;
  kAgree: () => number;
  mode: () => Mode;
  annotColor: () => string;
  annotOpacity: () => number;
}

const KBreakdown: Component<Props> = (props) => {
  const rows = createMemo(() => {
    const sliderVal = props.kAgree();
    const m = props.mode();
    const color = props.annotColor();
    const opacity = props.annotOpacity();
    const mTotal = props.mTotal;

    return Array.from({ length: mTotal }, (_, i) => {
      const mi = i + 1;
      const ek = m === 'relative'
        ? (sliderVal === 0 ? 0 : Math.max(1, Math.ceil(sliderVal / 100 * mi)))
        : sliderVal;

      return Array.from({ length: mi }, (_, j) => {
        const k = j + 1;
        const active = ek === 0 || k >= ek;
        return active
          ? hexToRgba(color, Math.min(1, (m === 'absolute' ? k / mTotal : k / mi) * opacity))
          : 'rgba(255,255,255,0.07)';
      });
    });
  });

  return (
    <div class={styles.kBreakdown}>
      <For each={rows()}>
        {(segs) => (
          <div class={styles.kBdBar} data-testid="k-bd-bar">
            <For each={segs}>
              {(bg) => <div class={styles.kBdSeg} data-testid="k-bd-seg" style={{ background: bg }} />}
            </For>
          </div>
        )}
      </For>
    </div>
  );
};

export default KBreakdown;
