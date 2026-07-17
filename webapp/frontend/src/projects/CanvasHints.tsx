import { type Component, createSignal, Show, onCleanup } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { ViewBox } from './canvasShapes';
import { t } from '../i18n/catalog';
import * as styles from './CanvasHints.css';

type Props = {
  vb: Accessor<ViewBox>;
};

// BUG #30: the always-on bottom controls/hints bar is replaced by an on-demand
// popup. A small "?" button (corner) opens a closable panel containing the SAME
// control information (canvas.help + live viewport readout) laid out vertically.
// Closes on the X button, an outside click, or Escape. Accessible: the trigger is
// a real <button> with aria-haspopup/aria-expanded, and Escape closes the panel.
// No annotation behaviour is touched — the readout is passive, exactly as before.
export const CanvasHints: Component<Props> = (props) => {
  const [open, setOpen] = createSignal(false);
  let panelRef: HTMLDivElement | undefined;
  let triggerRef: HTMLButtonElement | undefined;

  const close = () => setOpen(false);

  const onDocPointerDown = (e: PointerEvent) => {
    if (!open()) return;
    const t = e.target as Node | null;
    if (panelRef && t && panelRef.contains(t)) return;
    if (triggerRef && t && triggerRef.contains(t)) return;
    close();
  };
  const onDocKeyDown = (e: KeyboardEvent) => {
    if (open() && e.key === 'Escape') close();
  };

  // Listeners are attached only while open, so the closed state adds zero overhead
  // and never intercepts canvas pointer/keyboard events.
  const toggle = () => {
    const next = !open();
    setOpen(next);
    if (next) {
      document.addEventListener('pointerdown', onDocPointerDown, true);
      document.addEventListener('keydown', onDocKeyDown, true);
    } else {
      document.removeEventListener('pointerdown', onDocPointerDown, true);
      document.removeEventListener('keydown', onDocKeyDown, true);
    }
  };
  onCleanup(() => {
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    document.removeEventListener('keydown', onDocKeyDown, true);
  });

  return (
    <div class={styles.hints}>
      {/* Bottom-left: the "?" opens the help popup. */}
      <div class={styles.triggerWrap}>
        <button
          ref={triggerRef}
          type="button"
          class={styles.trigger}
          aria-haspopup="dialog"
          aria-expanded={open()}
          aria-label="Controls"
          data-testid="canvas-hints-trigger"
          onClick={toggle}
        >
          ?
        </button>
        <Show when={open()}>
          <div ref={panelRef} class={styles.panel} role="dialog" aria-label="Controls" data-testid="canvas-hints-panel">
            <button
              type="button"
              class={styles.close}
              aria-label="Close controls"
              data-testid="canvas-hints-close"
              onClick={close}
            >
              ✕
            </button>
            <div class={styles.help}>{t('canvas.help')}</div>
          </div>
        </Show>
      </div>
      {/* Bottom-right: the live viewport x/y/w/h readout — ALWAYS visible (t63), not hidden
          behind the "?" as it briefly was under BUG #30's popup. */}
      <div class={styles.readout} data-testid="canvas-viewport-readout">
        {t('canvas.viewport', {
          x: Math.round(props.vb().x),
          y: Math.round(props.vb().y),
          w: Math.round(props.vb().w),
          h: Math.round(props.vb().h),
        })}
      </div>
    </div>
  );
};
