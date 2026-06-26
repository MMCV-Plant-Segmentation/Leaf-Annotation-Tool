import { Component, Show, createSignal, onMount, onCleanup } from 'solid-js';
import * as store from './store';
import { showHomeScreen } from './lib/bridge';
import { currentUser, logout } from '../auth';
import styles from './AnalyzeHeader.module.css';
import ui from '../shared/ui.module.css';

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
      class={styles.rangeInput}
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
  let wrapRef: HTMLDivElement | undefined;

  const onDocClick = (e: MouseEvent) => {
    if (!popupOpen()) return;
    if (wrapRef?.contains(e.target as Node)) return;
    setPopupOpen(false);
  };
  onMount(() => document.addEventListener('click', onDocClick));
  onCleanup(() => document.removeEventListener('click', onDocClick));

  return (
    <>
      <Show when={currentUser()}>
        <span style="font-size:0.8rem;color:var(--color-text-muted,#666)">{currentUser()!.username}</span>
        <button style="font-size:0.8rem" onClick={() => void logout()}>Log out</button>
      </Show>
      <input
        type="color"
        class={styles.colorPick}
        value={store.annotColor()}
        title="Annotation color"
        onInput={e => store.setAnnotColor((e.target as HTMLInputElement).value)}
      />
      <div class={styles.opacityPickWrap} ref={wrapRef}>
        <button
          class={styles.opacityPickBtn}
          title="Annotation opacity"
          onClick={() => setPopupOpen(o => !o)}
        />
        <Show when={popupOpen()}>
          <div class={styles.opacityPopup}>
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
        class={store.blind() ? ui.active : ''}
        onClick={() => store.setBlind(!store.blind())}
      >🙈 Blind</button>
      <button
        id="analyze-bbox-btn"
        class={store.showBbox() ? ui.active : ''}
        onClick={() => store.setShowBbox(!store.showBbox())}
      >⬚ Bbox</button>
      <button onClick={showHomeScreen}>Home</button>
    </>
  );
};

export default AnalyzeHeader;
