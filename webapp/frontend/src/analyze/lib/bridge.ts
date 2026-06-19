import type { PairSummary } from './types';

declare global {
  interface Window {
    availablePairs: PairSummary[];
    _makeKindTag: (p: PairSummary) => Element[];
    _countLabel: (p: PairSummary) => string;
    openBylineModal: (onConfirm: (() => void) | null) => void;
    showHomeScreen: () => void;
    // buildIoUDetail will be replaced by shared/IoUDetail.tsx in Step 7
    buildIoUDetail: (intersectionPx: number, unionPx: number) => Node;
    initAnalyze: () => void;
  }
}

export const getAvailablePairs = (): PairSummary[] => window.availablePairs ?? [];
export const makeKindTag = (p: PairSummary): Element[] => window._makeKindTag(p);
export const countLabel = (p: PairSummary): string => window._countLabel(p);
export const openBylineModal = (onConfirm: (() => void) | null): void =>
  window.openBylineModal(onConfirm);
export const showHomeScreen = (): void => window.showHomeScreen();
