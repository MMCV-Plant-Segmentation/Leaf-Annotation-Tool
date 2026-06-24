import { Component, Show, createEffect, createSignal } from 'solid-js';
import { Root as DialogRoot, Portal as DialogPortal, Overlay as DialogOverlay,
         Content as DialogContent, Title as DialogTitle,
         Description as DialogDescription } from '@kobalte/core/dialog';
import { getUser, setUser } from '../analyze/lib/bridge';
import styles from './BylineModal.module.css';
import ui from '../shared/ui.module.css';

// Module-level: controlled from outside the reactive tree
const [open, setOpen] = createSignal(false);
let pendingCb: (() => void) | null = null;
let cancelable = false;

export function openBylineModal(onConfirm: (() => void) | null): void {
  pendingCb = onConfirm;
  cancelable = !!getUser();
  setOpen(true);
}

const BylineModal: Component = () => {
  const [name, setName] = createSignal('');
  const [error, setError] = createSignal(false);

  // Pre-fill input with current username when dialog opens
  createEffect(() => {
    if (open()) {
      setName(getUser() ?? '');
      setError(false);
    }
  });

  function confirm() {
    const trimmed = name().trim();
    if (!trimmed) { setError(true); return; }
    setOpen(false);
    setUser(trimmed);
    const cb = pendingCb;
    pendingCb = null;
    cb?.();
  }

  function dismiss() {
    if (!cancelable) return;
    setOpen(false);
    pendingCb = null;
  }

  return (
    <DialogRoot open={open()} onOpenChange={v => { if (!v) dismiss(); }}>
      <DialogPortal>
        <DialogOverlay class={styles.backdrop} />
        <DialogContent
          class={styles.panel}
          onEscapeKeyDown={e => { if (!cancelable) e.preventDefault(); }}
          onInteractOutside={e => { if (!cancelable) e.preventDefault(); }}
        >
          <DialogTitle class={styles.title}>Who are you?</DialogTitle>
          <DialogDescription class={styles.sub}>
            Enter a display name. This is shown alongside your annotations — no password needed.
          </DialogDescription>
          <input
            type="text"
            class={ui.textInput}
            placeholder="Your name"
            autocomplete="off"
            maxLength={64}
            value={name()}
            onInput={e => { setName((e.target as HTMLInputElement).value); setError(false); }}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); confirm(); } }}
          />
          <Show when={error()}>
            <p class={styles.errorText}>Please enter a name.</p>
          </Show>
          <button class={ui.btnPrimary} onClick={confirm}>Continue</button>
        </DialogContent>
      </DialogPortal>
    </DialogRoot>
  );
};

export default BylineModal;
