import { Component, For, createMemo, onMount, onCleanup } from 'solid-js';
import { Root as SliderRoot, Track as SliderTrack,
         Thumb as SliderThumb, Input as SliderInput } from '@kobalte/core/slider';
import { Root as PopoverRoot, Trigger as PopoverTrigger,
         Portal as PopoverPortal, Content as PopoverContent } from '@kobalte/core/popover';
import * as store from './store';
import { hexToRgba } from './lib/geometry';
import { t } from '../i18n/catalog';
import KBreakdown from '../shared/KBreakdown';
import * as styles from './AnalyzeSidebar.css';
import * as ui from '../shared/ui.css';

// The "Overlap level" control: a k-agree slider with a per-m breakdown grid, plus
// its derived label/background. Split out of AnalyzeSidebar to keep files <200 lines.
const OverlapLevelField: Component = () => {
  const d = store.data!;

  const kMax = () => store.mode() === 'absolute' ? d.mTotal : 100;
  const kAgreeLabel = () => {
    const v = store.kAgree();
    if (v === 0) return t('analyze.overlapAny');
    return store.mode() === 'absolute'
      ? t('analyze.overlapAbsolute', { v, m: d.mTotal })
      : t('analyze.overlapRelative', { v });
  };

  const kSliderBg = createMemo(() => {
    const val = store.kAgree();
    const max = kMax();
    const pct = max > 0 ? (val / max) * 100 : 100;
    const left = pct.toFixed(1) + '%';
    const color = store.annotColor();
    const dim  = hexToRgba(color, 0.35);
    const full = hexToRgba(color, 1.0);
    return [
      `linear-gradient(to right, var(--border) ${left}, transparent ${left})`,
      `linear-gradient(to right, ${dim} 0%, ${full} 100%)`,
    ].join(', ');
  });

  // k-agree slider wheel handler (needs passive:false for preventDefault)
  let kSliderRef: HTMLElement | undefined;
  onMount(() => {
    if (!kSliderRef) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      store.setKAgree(Math.max(0, Math.min(kMax(), store.kAgree() + dir)));
      store.setDetailK(null);
    };
    kSliderRef.addEventListener('wheel', handler, { passive: false });
    onCleanup(() => kSliderRef!.removeEventListener('wheel', handler));
  });

  return (
    <div class={ui.field}>
      <div style="display:flex;align-items:center;gap:4px">
        <label>{t('analyze.overlapLevel')}</label>
        <PopoverRoot>
          <PopoverTrigger class={ui.btnInfo}>?</PopoverTrigger>
          <PopoverPortal>
            <PopoverContent class={ui.iouTooltip}>
              {t('analyze.overlapTooltip')}
            </PopoverContent>
          </PopoverPortal>
        </PopoverRoot>
        <span style="margin-left:auto;font-size:0.82rem;color:var(--user);font-weight:600">
          {kAgreeLabel()}
        </span>
      </div>
      <div class={styles.kOverlapGrid}>
        <div class={styles.kOverlapLeft}>
          <div class={styles.kBdSpacer} />
          <For each={Array.from({ length: d.mTotal }, (_, i) => i + 1)}>
            {(mi) => <div class={styles.kBdLeftLabel}>{`m=${mi}`}</div>}
          </For>
        </div>
        <div class={styles.kOverlapRight}>
          <div class={styles.kSliderWrapper}>
            <SliderRoot
              class={styles.kSlider}
              ref={(el: HTMLElement) => { kSliderRef = el; }}
              value={[store.kAgree()]}
              minValue={0}
              maxValue={kMax()}
              step={1}
              onChange={([v]) => { store.setKAgree(v); store.setDetailK(null); }}
            >
              <SliderTrack
                class={styles.kTrack}
                style={{ background: kSliderBg() }}
              >
                <SliderThumb class={styles.kThumb}>
                  <SliderInput id="analyze-agree-k-slider" />
                </SliderThumb>
              </SliderTrack>
            </SliderRoot>
          </div>
          <KBreakdown
            mTotal={d.mTotal}
            kAgree={store.kAgree}
            mode={store.mode}
            annotColor={store.annotColor}
            annotOpacity={store.annotOpacity}
          />
        </div>
      </div>
    </div>
  );
};

export default OverlapLevelField;
