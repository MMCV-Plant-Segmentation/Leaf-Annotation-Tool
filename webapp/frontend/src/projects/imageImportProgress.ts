/**
 * Shared import/upload progress state for the Images screen, extracted to keep
 * ProjectImagesScreen.tsx under 200 lines. Both the browser-upload flow and the
 * server-path-import flow feed the same `ImportEvent` stream into one reducer.
 *
 * Upload UX fix: the browser-upload flow (uploadWithPreflight) hashes every selected
 * file BEFORE any network activity — that used to leave the progress bar showing
 * "0 / 0" (silent hashing phase) and `total` reflected only the server's *missing*
 * count, so an upload with any dedup skips never visually reached 100%. Now:
 *   - `start(n)` is called with the SELECTED file count the instant upload begins, so
 *     "… / N" is correct immediately and `phase()` flips to 'hashing'.
 *   - `fastForward(n)` is called once preflight knows which files are already-present
 *     (registered by hash, no bytes sent) — those `n` files count as done immediately
 *     (so the bar can still reach 100% even when everything dedupes), and `phase()`
 *     flips to 'uploading'.
 *   - `pct()` blends the fast-forwarded baseline with BYTE-level progress for the
 *     files actually being uploaded, so the bar stays smooth for large images without
 *     losing the skipped files' contribution to the total.
 */
import { createSignal } from 'solid-js';
import { t } from '../i18n/catalog';
import type { ImportEvent } from './api';

export type ImportPhase = 'idle' | 'hashing' | 'uploading' | 'done';

export type ImportProgress = {
  busy: () => boolean;
  phase: () => ImportPhase;
  total: () => number;
  done: () => number;
  errs: () => number;
  summary: () => string;
  pct: () => number;
  /** Begin a run knowing the SELECTED file count up front (before hashing/network). */
  start: (n: number) => void;
  /** Already-present files: fast-forward `done` by `n` and move past the hashing phase. */
  fastForward: (n: number) => void;
  /** Feed the next streamed event; returns the count of already-present (dedup) files. */
  onEvent: (ev: ImportEvent, alreadyPresent: () => number) => void;
  reset: () => void;
  setBusy: (v: boolean) => void;
  setSummary: (s: string) => void;
};

export function createImportProgress(): ImportProgress {
  const [busy, setBusy] = createSignal(false);
  const [phase, setPhase] = createSignal<ImportPhase>('idle');
  const [total, setTotal] = createSignal(0);
  const [done, setDone] = createSignal(0);
  const [errs, setErrs] = createSignal(0);
  const [summary, setSummary] = createSignal('');
  const [skipBase, setSkipBase] = createSignal(0);   // fast-forwarded (already-present) count
  const [byteLoaded, setByteLoaded] = createSignal(0);
  const [byteTotal, setByteTotal] = createSignal(0);

  const reset = () => {
    setPhase('idle'); setTotal(0); setDone(0); setErrs(0); setSummary('');
    setSkipBase(0); setByteLoaded(0); setByteTotal(0);
  };

  const start = (n: number) => {
    setTotal(n); setDone(0); setErrs(0); setSummary('');
    setSkipBase(0); setByteLoaded(0); setByteTotal(0);
    setPhase('hashing');
  };

  const fastForward = (n: number) => {
    if (n > 0) { setSkipBase(n); setDone((d) => d + n); }
    setPhase('uploading');
  };

  // Byte fraction covers only the files actually being uploaded (total() - skipBase()) so
  // already-skipped files keep their share of the bar instead of it resetting to 0%.
  const pct = () => {
    const tot = total();
    if (tot === 0) return 0;
    const remaining = tot - skipBase();
    if (byteTotal() > 0 && remaining > 0) {
      const frac = skipBase() + (byteLoaded() / byteTotal()) * remaining;
      return Math.round((frac / tot) * 100);
    }
    return Math.round((done() / tot) * 100);
  };

  const onEvent = (ev: ImportEvent, alreadyPresent: () => number) => {
    if (ev.type === 'start') {
      // `total` is fixed by start() for the browser-upload flow (selection count known
      // up front); the server-path-import flow never calls start() first, so total()
      // is still 0 here and this is its one chance to learn the count.
      if (total() === 0) setTotal(ev.total);
      setPhase('uploading');
    } else if (ev.type === 'progress') {
      setByteLoaded(ev.loaded); setByteTotal(ev.total);
    } else if (ev.type === 'file') {
      setDone((n) => n + 1); if (!ev.ok) setErrs((n) => n + 1);
    } else if (ev.type === 'done') {
      setPhase('done');
      const p = alreadyPresent();
      setSummary(t('detail.images.importDone', {
        imported: ev.imported, skipped: ev.skipped + p, errors: ev.errors.length,
      }) + (p > 0 ? ' ' + t('detail.images.presentNote', { present: p }) : ''));
    }
  };

  return { busy, phase, total, done, errs, summary, pct, start, fastForward, onEvent, reset, setBusy, setSummary };
}
