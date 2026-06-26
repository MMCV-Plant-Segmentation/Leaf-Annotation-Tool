import type { PairSummary } from './types';

declare global {
  interface Window {
    availablePairs: PairSummary[];
    showHomeScreen: () => void;
    // buildIoUDetail will be replaced by shared/IoUDetail.tsx in Step 7
    buildIoUDetail: (intersectionPx: number, unionPx: number) => Node;
  }
}

export const getAvailablePairs = (): PairSummary[] => window.availablePairs ?? [];
export const showHomeScreen = (): void => window.showHomeScreen();
