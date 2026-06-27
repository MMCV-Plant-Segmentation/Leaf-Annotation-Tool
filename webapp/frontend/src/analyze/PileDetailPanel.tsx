import { Component, For, Show, createMemo } from 'solid-js';
import { effectiveKAgree } from './lib/agreement';
import { polygonArea, hexToRgba } from './lib/geometry';
import * as store from './store';
import type { Pile } from './lib/types';
import { t } from '../i18n/catalog';
import IoUDetail from '../shared/IoUDetail';
import * as styles from './PileDetailPanel.css';

interface Props {
  pile: Pile;
}

const PileDetailPanel: Component<Props> = (props) => {
  const mTotal = store.data!.mTotal;

  const effectiveK = createMemo(() =>
    store.detailK() ?? effectiveKAgree(store.kAgree(), props.pile.m, store.mode())
  );

  const iouDetail = createMemo(() => {
    const k = effectiveK();
    const iEntry = props.pile.agreementByK[String(k)];
    const uEntry = props.pile.agreementByK['1'];
    if (!iEntry || !uEntry) return null;
    return {
      intersectionPx: polygonArea(iEntry.rings),
      unionPx: polygonArea(uEntry.rings),
    };
  });

  return (
    <>
      <div class={styles.agreementBreakdown}>
        <div class={styles.breakdownTitle}>
          {props.pile.m !== 1
            ? t('pile.annotatorsPlural', { m: props.pile.m })
            : t('pile.annotatorsSingular', { m: props.pile.m })}
        </div>
        <For each={Array.from({ length: props.pile.m }, (_, i) => i + 1)}>
          {(ki) => {
            const entry = () => props.pile.agreementByK[String(ki)];
            const pct = () => { const e = entry(); return e ? Math.round(e.fraction * 100) : 0; };
            const isActive = () => effectiveK() === ki;
            const barColor = () => hexToRgba(
              store.annotColor(),
              Math.min(1, (store.mode() === 'absolute' ? ki / mTotal : ki / props.pile.m) * store.annotOpacity())
            );

            return (
              <div
                class={`${styles.breakdownRow}${isActive() ? ' ' + styles.breakdownRowActive : ''}`}
                data-testid="breakdown-row"
                data-active={isActive() ? 'true' : undefined}
                style="cursor:pointer"
                onClick={() => store.setDetailK(ki)}
              >
                <span class={styles.breakdownK}>≥ {ki}</span>
                <div class={styles.breakdownBarWrap}>
                  <div
                    class={styles.breakdownBar}
                    style={{ width: pct() + '%', background: isActive() ? undefined : barColor() }}
                  />
                </div>
                <span class={styles.breakdownPct}>{pct()}%</span>
              </div>
            );
          }}
        </For>
      </div>
      <Show when={iouDetail()}>
        {(detail) => (
          <div style="margin-top:8px">
            <IoUDetail
              intersectionPx={detail().intersectionPx}
              unionPx={detail().unionPx}
            />
          </div>
        )}
      </Show>
    </>
  );
};

export default PileDetailPanel;
