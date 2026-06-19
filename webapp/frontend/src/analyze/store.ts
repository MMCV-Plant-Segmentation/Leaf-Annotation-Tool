import { createSignal, batch } from 'solid-js';
import { convertMode } from './lib/agreement';
import type { AnalyzeData, Mode } from './lib/types';

// Non-reactive — set once per dataset load
export let data: AnalyzeData | null = null;

// Signals — created at module level (fine for app-level singletons)
export const [kMin,          setKMin]          = createSignal(2);
export const [kAgree,        setKAgree]        = createSignal(3);
export const [iouFilter,     setIouFilter]     = createSignal(0.01);
export const [mode,          _setMode]         = createSignal<Mode>('absolute');
export const [annotColor,    setAnnotColor]    = createSignal('#4a9eff');
export const [annotOpacity,  setAnnotOpacity]  = createSignal(0.5);
export const [showBbox,      setShowBbox]      = createSignal(true);
export const [blind,         setBlind]         = createSignal(false);
export const [selectedId,    setSelectedId]    = createSignal<string | null>(null);
export const [detailK,       setDetailK]       = createSignal<number | null>(null);
export const [revision,      bump]             = createSignal(0);
export const [img,           setImg]           = createSignal<HTMLImageElement | null>(null);

/** Mode switch with automatic kAgree conversion and detailK reset. */
export function setMode(newMode: Mode) {
  if (!data) return;
  batch(() => {
    if (mode() !== newMode) setKAgree(convertMode(kAgree(), mode(), newMode, data!.mTotal));
    _setMode(newMode);
    setDetailK(null);
  });
}

/** Reset all signals to defaults for a fresh dataset. */
export function initStore(d: AnalyzeData) {
  data = d;
  batch(() => {
    setKMin(2);
    setKAgree(d.mTotal);
    setIouFilter(0.01);
    _setMode('absolute');
    setAnnotColor('#4a9eff');
    setAnnotOpacity(0.5);
    setShowBbox(true);
    setBlind(false);
    setSelectedId(null);
    setDetailK(null);
    setImg(null);
    bump(r => r + 1);
  });
}
