import { Component, Show, createSignal, onMount, onCleanup, type JSX } from 'solid-js';
import * as store from './store';
import { openBylineModal, showHomeScreen } from './lib/bridge';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const w = window as any;

// Separate component so onMount/onCleanup track the Show lifecycle, not the header's
const OpacitySlider: Component = () => {
  let ref: HTMLInputElement | undefined;
  onMount(() => {
    if (!ref) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      const cur = Math.round(store.annotOpacity() * 100);
      store.setAnnotOpacity(Math.max(0, Math.min(100, cur + dir)) / 100);
    };
    ref.addEventListener('wheel', handler, { passive: false });
    onCleanup(() => ref!.removeEventListener('wheel', handler));
  });

  return (
    <input
      type="range"
      id="analyze-opacity-slider"
      class="range-input"
      min={0}
      max={100}
      value={Math.round(store.annotOpacity() * 100)}
      ref={ref}
      onInput={e => store.setAnnotOpacity(+(e.target as HTMLInputElement).value / 100)}
    />
  );
};

const AnalyzeHeader: Component = () => {
  const [popupOpen, setPopupOpen] = createSignal(false);

  const onDocClick = (e: MouseEvent) => {
    if (!popupOpen()) return;
    if ((e.target as Element).closest('.opacity-pick-wrap')) return;
    setPopupOpen(false);
  };
  onMount(() => document.addEventListener('click', onDocClick));
  onCleanup(() => document.removeEventListener('click', onDocClick));

  return (
    <>
      <button
        class="btn-byline-change"
        title="Change display name"
        onClick={() => openBylineModal(null)}
      />
      <input
        type="color"
        class="analyze-color-pick"
        value={store.annotColor()}
        title="Annotation color"
        onInput={e => store.setAnnotColor((e.target as HTMLInputElement).value)}
      />
      <div class="opacity-pick-wrap">
        <button
          class="opacity-pick-btn"
          title="Annotation opacity"
          onClick={() => setPopupOpen(o => !o)}
        />
        <Show when={popupOpen()}>
          <div class="opacity-popup">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
              <span style="font-size:0.8rem;font-weight:600">Opacity</span>
              <span style="font-size:0.8rem;color:var(--user)">
                {Math.round(store.annotOpacity() * 100)}%
              </span>
            </div>
            <OpacitySlider />
          </div>
        </Show>
      </div>
      <button
        id="analyze-blind-btn"
        class={store.blind() ? 'active' : ''}
        onClick={() => store.setBlind(!store.blind())}
      >🙈 Blind</button>
      <button
        id="analyze-bbox-btn"
        class={store.showBbox() ? 'active' : ''}
        onClick={() => store.setShowBbox(!store.showBbox())}
      >⬚ Bbox</button>
      <button
        onClick={() => {
          document.getElementById('analyze-screen')!.hidden = true;
          document.getElementById('setup-screen')!.hidden   = false;
          w.analyzeData = null;
          showHomeScreen();
        }}
      >Home</button>
    </>
  );
};

export default AnalyzeHeader;
