import { type Component, createEffect, createSignal, onCleanup } from 'solid-js';
import { A } from '@solidjs/router';
import { t } from '../i18n/catalog';
import { penMode, togglePenMode } from './penMode';
import * as styles from './BrushMenu.css';

type Props = {
  active: boolean;
  testId: string;
  title: string;
  label: string;
  toolClass: string;
  onClick: () => void;
};

// Long-press threshold for touch/pen — same ballpark as the OS text-selection callout.
const LONG_PRESS_MS = 500;

/**
 * t161 — the Brush tool button, plus its hidden popup (pen mode + /calibrate). Right-click
 * or a long-press (touch/pen, ≥500ms, opens while still held) reveals it; a plain click/tap
 * just selects Brush. No visual marker that the popup exists — only the pen-mode badge,
 * which is a separate, persistent piece of state.
 */
export const BrushMenu: Component<Props> = (props) => {
  const [open, setOpen] = createSignal(false);
  let btnRef: HTMLButtonElement | undefined;
  let menuRef: HTMLDivElement | undefined;
  let pressTimer: ReturnType<typeof setTimeout> | undefined;

  const clearPressTimer = () => {
    if (pressTimer !== undefined) { clearTimeout(pressTimer); pressTimer = undefined; }
  };

  const onContextMenu = (e: MouseEvent) => { e.preventDefault(); setOpen(true); };

  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') return;  // mouse uses the contextmenu path above
    clearPressTimer();
    pressTimer = setTimeout(() => setOpen(true), LONG_PRESS_MS);
  };
  const onPointerUp = () => clearPressTimer();
  const onPointerCancel = () => clearPressTimer();

  // Close on Escape or an outside pointerdown — but a pointerdown INSIDE the popup (e.g. on
  // pen-mode-toggle) must not close it before its own click handler runs.
  createEffect(() => {
    if (!open()) return;
    const onDocPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (menuRef?.contains(target) || btnRef?.contains(target)) return;
      setOpen(false);
    };
    // stopPropagation: the canvas has its OWN window-level Escape shortcut (clears the
    // draft + switches tool to 'pan', see canvasKeyboard.ts) — closing this popup must not
    // also trigger that (it bubbles document → window, so stopping it here is enough).
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('pointerdown', onDocPointerDown);
    document.addEventListener('keydown', onKeyDown);
    onCleanup(() => {
      document.removeEventListener('pointerdown', onDocPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    });
  });

  return (
    <span class={styles.wrap}>
      <button ref={btnRef} class={`${props.toolClass} ${styles.brushButton}`}
        aria-pressed={props.active}
        onClick={props.onClick}
        onContextMenu={onContextMenu}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        title={props.title}
        data-testid={props.testId}>
        {props.label}
        {penMode() && <span class={styles.penModeBadge} data-testid="pen-mode-badge" />}
      </button>
      {open() && (
        <div ref={menuRef} class={styles.menu} data-testid="brush-menu">
          <button class={styles.menuItem} data-testid="pen-mode-toggle" onClick={() => togglePenMode()}>
            {t('canvas.penMode')}
          </button>
          <A href="/calibrate" class={styles.menuItem} data-testid="brush-menu-calibrate">
            {t('calibrate.open')}
          </A>
        </div>
      )}
    </span>
  );
};
