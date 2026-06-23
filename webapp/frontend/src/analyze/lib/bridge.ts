import type { PairSummary } from './types';

declare global {
  interface Window {
    availablePairs: PairSummary[];
    openBylineModal: (onConfirm: (() => void) | null) => void;
    showHomeScreen: () => void;
    getUser: () => string | null;
    setUser: (name: string) => void;
    // buildIoUDetail will be replaced by shared/IoUDetail.tsx in Step 7
    buildIoUDetail: (intersectionPx: number, unionPx: number) => Node;
    initAnalyze: () => void;
  }
}

export const getAvailablePairs = (): PairSummary[] => window.availablePairs ?? [];
export const openBylineModal = (onConfirm: (() => void) | null): void =>
  window.openBylineModal(onConfirm);
export const showHomeScreen = (): void => window.showHomeScreen();
export const getUser = (): string | null => window.getUser();
export const setUser = (name: string): void => window.setUser(name);
