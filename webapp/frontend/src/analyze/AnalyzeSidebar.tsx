import { Component, Show, createEffect, createMemo } from 'solid-js';
import { Root as PopoverRoot, Trigger as PopoverTrigger,
         Portal as PopoverPortal, Content as PopoverContent } from '@kobalte/core/popover';
import * as store from './store';
import { computeVisiblePiles } from './lib/agreement';
import { t } from '../i18n/catalog';
import ModeToggle from '../shared/ModeToggle';
import SliderField from '../shared/SliderField';
import OverlapLevelField from './OverlapLevelField';
import PileDetailPanel from './PileDetailPanel';
import * as ui from '../shared/ui.css';

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
    const statsKey = visible.length > 0 ? 'analyze.statsAvgIoU' : 'analyze.stats';
    const stats = t(statsKey, {
      shown: visible.length,
      filtered: filteredCount,
      total,
      avg: Math.round(avgFraction * 100),
    });
    const el = document.getElementById('analyze-stats');
    if (el) el.textContent = stats;
  });

  return (
    <>
      {/* Mode toggle */}
      <div class={ui.field}>
        <div style="display:flex;align-items:center;gap:6px">
          <ModeToggle value={store.mode} onChange={store.setMode} />
          <PopoverRoot>
            <PopoverTrigger class={ui.btnInfo}>?</PopoverTrigger>
            <PopoverPortal>
              <PopoverContent class={ui.iouTooltip}>
                <strong>{t('analyze.mode.absoluteLabel')}</strong> {t('analyze.mode.absoluteDesc')}<br /><br />
                <strong>{t('analyze.mode.relativeLabel')}</strong> {t('analyze.mode.relativeDesc')}
              </PopoverContent>
            </PopoverPortal>
          </PopoverRoot>
        </div>
      </div>

      {/* Min. annotators */}
      <SliderField
        label={t('analyze.minAnnotators')}
        id="analyze-agree-slider"
        tooltip={t('analyze.minAnnotatorsTooltip')}
        value={store.kMin}
        onChange={v => store.setKMin(v)}
        min={0}
        max={d.mTotal}
        displayValue={() => t('analyze.minAnnotatorsValue', { k: store.kMin(), m: d.mTotal })}
        wheelStepping
      />

      {/* Overlap level */}
      <OverlapLevelField />

      {/* Min IoU */}
      <SliderField
        label={t('analyze.minIoU')}
        id="analyze-iou-slider"
        tooltip={t('analyze.minIoUTooltip')}
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
