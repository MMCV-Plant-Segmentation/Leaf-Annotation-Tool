import { Component, For, Show, createEffect, createMemo, onMount, onCleanup } from 'solid-js';
import { Root as SliderRoot, Track as SliderTrack,
         Thumb as SliderThumb, Input as SliderInput } from '@kobalte/core/slider';
import { Root as PopoverRoot, Trigger as PopoverTrigger,
         Portal as PopoverPortal, Content as PopoverContent } from '@kobalte/core/popover';
import * as store from './store';
import { computeVisiblePiles } from './lib/agreement';
import { hexToRgba } from './lib/geometry';
import ModeToggle from '../shared/ModeToggle';
import SliderField from '../shared/SliderField';
import KBreakdown from '../shared/KBreakdown';
import PileDetailPanel from './PileDetailPanel';
import styles from './AnalyzeSidebar.module.css';

const AnalyzeSidebar: Component = () => {
  const d = store.data!;

  // Visible piles — used for stats header and selection guard
  const vpResult = createMemo(() =>
    computeVisiblePiles(d, {
      kMin:      store.kMin(),
      kAgree:    store.kAgree(),
      iouFilter: store.iouFilter(),
      mode:      store.mode(),
    })
  );

  // Selected pile (only if it's in the visible set)
  const selPile = createMemo(() => {
    const id = store.selectedId();
    if (!id) return null;
    return vpResult().visible.find(r => r.pile.id === id)?.pile ?? null;
  });

  // Clear selection when the pile is filtered out
  createEffect(() => {
    if (store.selectedId() && !selPile()) {
      store.setSelectedId(null);
      store.setDetailK(null);
    }
  });

  // Update the stats span in the header
  createEffect(() => {
    const { visible, filteredCount } = vpResult();
    const total = d.piles.length;
    const avgFraction = visible.length > 0
      ? visible.reduce((s, r) => s + r.fraction, 0) / visible.length
      : 0;
    let stats = `${visible.length} shown · ${filteredCount} filtered · ${total} total`;
    if (visible.length > 0) stats += ` · avg IoU: ${Math.round(avgFraction * 100)}%`;
    const el = document.getElementById('analyze-stats');
    if (el) el.textContent = stats;
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

  // k-agree derived values
  const kMax = () => store.mode() === 'absolute' ? d.mTotal : 100;
  const kAgreeLabel = () => {
    const v = store.kAgree();
    if (v === 0) return 'any';
    return store.mode() === 'absolute' ? `≥ ${v}/${d.mTotal}` : `≥ ${v}%`;
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

  return (
    <>
      {/* Mode toggle */}
      <div class="field">
        <div style="display:flex;align-items:center;gap:6px">
          <ModeToggle value={store.mode} onChange={store.setMode} />
          <PopoverRoot>
            <PopoverTrigger class="btn-info">?</PopoverTrigger>
            <PopoverPortal>
              <PopoverContent class="iou-tooltip">
                <strong>Absolute:</strong> Missing annotations count as disagreement — a lesion only 2 of 4 annotators drew is half as salient as one all 4 drew.<br /><br />
                <strong>Relative:</strong> Missing annotations are treated as oversight — salience reflects only the annotators who drew this lesion, so a 2-of-2 pile looks the same as a 4-of-4 pile.
              </PopoverContent>
            </PopoverPortal>
          </PopoverRoot>
        </div>
      </div>

      {/* Min. annotators */}
      <SliderField
        label="Min. annotators"
        id="analyze-agree-slider"
        tooltip="Hides lesions where the fraction of annotators who drew it is below this threshold. At 34%, a lesion only 1 of 3 annotators drew (33%) is hidden; one that 2 of 3 drew (67%) is shown. The stacked footprints show where annotators overlap — darker = more agreement."
        value={store.kMin}
        onChange={v => store.setKMin(v)}
        min={0}
        max={d.mTotal}
        displayValue={() => `≥ ${store.kMin()} of ${d.mTotal}`}
        wheelStepping
      />

      {/* Overlap level */}
      <div class="field">
        <div style="display:flex;align-items:center;gap:4px">
          <label>Overlap level</label>
          <PopoverRoot>
            <PopoverTrigger class="btn-info">?</PopoverTrigger>
            <PopoverPortal>
              <PopoverContent class="iou-tooltip">
                Controls how deeply annotators must overlap for the IoU calculation — higher values require stricter agreement. Click a bar in the pile breakdown to inspect a level's I∩U detail without changing this slider.
              </PopoverContent>
            </PopoverPortal>
          </PopoverRoot>
          <span style="margin-left:auto;font-size:0.82rem;color:var(--user);font-weight:600">
            {kAgreeLabel()}
          </span>
        </div>
        <div class="k-overlap-grid">
          <div class="k-overlap-left">
            <div class="k-bd-spacer" />
            <For each={Array.from({ length: d.mTotal }, (_, i) => i + 1)}>
              {(mi) => <div class="k-bd-left-label">m={mi}</div>}
            </For>
          </div>
          <div class="k-overlap-right">
            <div class="k-slider-wrapper">
              <SliderRoot
                class={styles.kSlider}
                value={[store.kAgree()]}
                minValue={0}
                maxValue={kMax()}
                step={1}
                onChange={([v]) => { store.setKAgree(v); store.setDetailK(null); }}
              >
                <SliderTrack
                  ref={(el: HTMLElement) => { kSliderRef = el; }}
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

      {/* Min IoU */}
      <SliderField
        label="Min IoU"
        id="analyze-iou-slider"
        tooltip="Hides lesions where the highlighted region is smaller than this % of the lesion's total annotated area. Raise it to show only lesions where annotators agreed well on the shape. Note: annotators who didn't draw a lesion at all are not included — the IoU is computed only among those who did."
        value={() => Math.round(store.iouFilter() * 100)}
        onChange={v => store.setIouFilter(v / 100)}
        min={0}
        max={100}
        displayValue={() => Math.round(store.iouFilter() * 100) + '%'}
        displayColor="var(--muted)"
        wheelStepping
      />

      {/* Pile detail panel */}
      <Show when={selPile()}>
        {(pile) => <PileDetailPanel pile={pile()} />}
      </Show>
    </>
  );
};

export default AnalyzeSidebar;
