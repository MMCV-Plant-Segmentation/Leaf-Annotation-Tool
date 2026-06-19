import { render } from 'solid-js/web';
import AnalyzeApp from './analyze/AnalyzeApp';
import AnalyzeSidebar from './analyze/AnalyzeSidebar';
import AnalyzeHeader from './analyze/AnalyzeHeader';
import { mountAnalyzeViewer } from './analyze/analyzeViewer';
import { initStore } from './analyze/store';
import type { AnalyzeData } from './analyze/lib/types';

declare global {
  interface Window {
    initAnalyze: () => void;
    showAnalyzeSetup: () => void;
  }
}

// Called by app.js's tile-analyze click; replaces analyze.js's showAnalyzeSetup.
// _hideAllSetupScreens is defined in compare_setup.js (classic script, already loaded).
window.showAnalyzeSetup = () => {
  (w as any)._hideAllSetupScreens?.();
  document.getElementById('analyze-setup')!.hidden = false;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const w = window as any;

window.initAnalyze = () => {
  const pairList    = document.getElementById('analyze-pair-list');
  const setupScreen = document.getElementById('analyze-setup');
  const analyzeScreen = document.getElementById('analyze-screen');
  if (!pairList || !setupScreen) return;

  let setupDispose:  (() => void) | null = null;
  let viewerDispose: (() => void) | null = null;

  function launchViewer(data: AnalyzeData) {
    // Screen transition
    document.getElementById('setup-screen')!.hidden = true;
    (analyzeScreen as HTMLElement).hidden            = false;
    document.getElementById('analyze-set-name')!.textContent = data.displayName;

    // Globals still read by click handler and any residual analyze.js code
    w.analyzeSelectedPile = null;
    w.analyzeDetailK      = null;
    w.analyzeData         = null; // viewer sets this after initStore

    // Initialize all Solid signals for the new dataset
    initStore(data);

    // Replace header controls with Solid component
    const headerEl = document.getElementById('analyze-header-right')!;
    headerEl.innerHTML = '';
    const headerDispose = render(() => <AnalyzeHeader />, headerEl);

    // Replace sidebar with Solid component
    const sidebarEl = document.getElementById('analyze-sidebar')!;
    sidebarEl.innerHTML = '';
    const sidebarDispose = render(() => <AnalyzeSidebar />, sidebarEl);

    // Mount canvas viewer (sets w.analyzeData, overrides _drawAnalyzeCanvas, owns canvas)
    viewerDispose?.();
    const canvasDispose = mountAnalyzeViewer(data);
    viewerDispose = () => {
      headerDispose();
      sidebarDispose();
      canvasDispose();
    };
  }

  // Dispose viewer when analyze-screen is hidden (user navigates home)
  if (analyzeScreen) {
    new MutationObserver(() => {
      if ((analyzeScreen as HTMLElement).hidden) {
        viewerDispose?.();
        viewerDispose = null;
      }
    }).observe(analyzeScreen, { attributes: true, attributeFilter: ['hidden'] });
  }

  // Wire #home-btn-analyze (visible during setup, hidden by AnalyzeSetup onMount)
  document.getElementById('home-btn-analyze')?.addEventListener('click', () => {
    w.showHomeScreen?.();
  });

  // Re-mount setup when analyze-setup becomes visible
  new MutationObserver(() => {
    if (!setupScreen.hidden) {
      setTimeout(() => {
        setupDispose?.();
        setupDispose = null;
        pairList.innerHTML = '';
        setupDispose = render(() => <AnalyzeApp onLaunch={launchViewer} />, pairList);
      }, 0);
    }
  }).observe(setupScreen, { attributes: true, attributeFilter: ['hidden'] });
};
