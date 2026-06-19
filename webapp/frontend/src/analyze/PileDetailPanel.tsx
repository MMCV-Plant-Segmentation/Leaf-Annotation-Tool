import { Component, For, Show, createMemo } from 'solid-js';
import { effectiveKAgree } from './lib/agreement';
import { polygonArea, hexToRgba } from './lib/geometry';
import * as store from './store';
import type { Pile } from './lib/types';
import IoUDetail from '../shared/IoUDetail';

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
      <div class="agreement-breakdown">
        <div class="breakdown-title">
          {props.pile.m} annotator{props.pile.m !== 1 ? 's' : ''} drew this lesion
        </div>
        <For each={Array.from({ length: props.pile.m }, (_, i) => i + 1)}>
          {(ki) => {
            const entry = props.pile.agreementByK[String(ki)];
            const pct = entry ? Math.round(entry.fraction * 100) : 0;
            const isActive = () => effectiveK() === ki;
            const barColor = () => hexToRgba(
              store.annotColor(),
              Math.min(1, (store.mode() === 'absolute' ? ki / mTotal : ki / props.pile.m) * store.annotOpacity())
            );

            return (
              <div
                class={`breakdown-row${isActive() ? ' breakdown-row-active' : ''}`}
                style="cursor:pointer"
                onClick={() => store.setDetailK(ki)}
              >
                <span class="breakdown-k">≥ {ki}</span>
                <div class="breakdown-bar-wrap">
                  <div
                    class="breakdown-bar"
                    style={{ width: pct + '%', background: isActive() ? undefined : barColor() }}
                  />
                </div>
                <span class="breakdown-pct">{pct}%</span>
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
