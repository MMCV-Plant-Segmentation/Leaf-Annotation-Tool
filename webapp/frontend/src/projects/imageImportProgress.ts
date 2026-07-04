/**
 * Shared import/upload progress state for the Images screen, extracted to keep
 * ProjectImagesScreen.tsx under 200 lines. Both the browser-upload flow and the
 * server-path-import flow feed the same `ImportEvent` stream into one reducer.
 */
import { createSignal } from 'solid-js';
import { t } from '../i18n/catalog';
import type { ImportEvent } from './api';

/** A clamped 0–100 percent for the progress bar from the current event stream. */
export type ImportProgress = {
  busy: () => boolean;
  total: () => number;
  done: () => number;
  errs: () => number;
  summary: () => string;
  pct: () => number;
  /** Feed the next streamed event; returns the count of already-present (dedup) files. */
  onEvent: (ev: ImportEvent, alreadyPresent: () => number) => void;
  reset: () => void;
  setBusy: (v: boolean) => void;
  setSummary: (s: string) => void;
};

export function createImportProgress(): ImportProgress {
  const [busy, setBusy] = createSignal(false);
  const [total, setTotal] = createSignal(0);
  const [done, setDone] = createSignal(0);
  const [errs, setErrs] = createSignal(0);
  const [summary, setSummary] = createSignal('');
  const [byteLoaded, setByteLoaded] = createSignal(0);
  const [byteTotal, setByteTotal] = createSignal(0);

  const reset = () => {
    setTotal(0); setDone(0); setErrs(0); setSummary('');
    setByteLoaded(0); setByteTotal(0);
  };

  // Use byte fraction when available (upload flow); fall back to file count (path-import flow).
  const pct = () => byteTotal() > 0
    ? Math.round((byteLoaded() / byteTotal()) * 100)
    : total() > 0 ? Math.round((done() / total()) * 100) : 0;

  const onEvent = (ev: ImportEvent, alreadyPresent: () => number) => {
    if (ev.type === 'start') { setTotal(ev.total); setDone(0); setErrs(0); }
    else if (ev.type === 'progress') { setByteLoaded(ev.loaded); setByteTotal(ev.total); }
    else if (ev.type === 'file') { setDone((n) => n + 1); if (!ev.ok) setErrs((n) => n + 1); }
    else if (ev.type === 'done') {
      const p = alreadyPresent();
      setSummary(t('detail.images.importDone', {
        imported: ev.imported, skipped: ev.skipped + p, errors: ev.errors.length,
      }) + (p > 0 ? ' ' + t('detail.images.presentNote', { present: p }) : ''));
    }
  };

  return { busy, total, done, errs, summary, pct, onEvent, reset, setBusy, setSummary };
}
