import { render } from 'solid-js/web';
import { Router, Route } from '@solidjs/router';
import AnalyzeSidebar from './analyze/AnalyzeSidebar';
import AnalyzeHeader from './analyze/AnalyzeHeader';
import { mountAnalyzeViewer } from './analyze/analyzeViewer';
import { initStore } from './analyze/store';
import AppRoot from './nav/AppRoot';
import HomeScreen from './nav/HomeScreen';
import ManageScreen from './nav/ManageScreen';
import TrainScreen from './nav/TrainScreen';
import MergeScreen from './nav/MergeScreen';
import AnalyzeRoute from './nav/AnalyzeRoute';
import BylineModal, { openBylineModal } from './nav/BylineModal';
import type { AnalyzeData } from './analyze/lib/types';

declare global {
  interface Window {
    initAnalyze: () => void;
    _launchAnalyze: (data: AnalyzeData) => void;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const w = window as any;

// ── BylineModal (mounts once; Dialog.Portal renders into body) ───────────────
const bylineMount = document.createElement('div');
document.body.appendChild(bylineMount);
render(() => <BylineModal />, bylineMount);
w.openBylineModal = openBylineModal;

// ── Router: all setup screens live here ──────────────────────────────────────
const homeEl = document.getElementById('home-screen');
if (homeEl) {
  homeEl.innerHTML = '';
  render(() => (
    <Router root={AppRoot}>
      <Route path="/" component={HomeScreen} />
      <Route path="/manage" component={ManageScreen} />
      <Route path="/train" component={TrainScreen} />
      <Route path="/merge" component={MergeScreen} />
      <Route path="/analyze" component={AnalyzeRoute} />
      <Route path="/*" component={HomeScreen} />
    </Router>
  ), homeEl);
}

// ── Analyze viewer init (called by app.js's IIFE) ────────────────────────────
window.initAnalyze = () => {
  const analyzeScreen = document.getElementById('analyze-screen');
  let viewerDispose: (() => void) | null = null;

  function launchViewer(data: AnalyzeData) {
    // Screen transition
    document.getElementById('setup-screen')!.hidden = true;
    (analyzeScreen as HTMLElement).hidden            = false;
    document.getElementById('analyze-set-name')!.textContent = data.displayName;

    // Globals still read by analyze.js residual code
    w.analyzeSelectedPile = null;
    w.analyzeDetailK      = null;
    w.analyzeData         = null;

    initStore(data);

    const headerEl = document.getElementById('analyze-header-right')!;
    headerEl.innerHTML = '';
    const headerDispose = render(() => <AnalyzeHeader />, headerEl);

    const sidebarEl = document.getElementById('analyze-sidebar')!;
    sidebarEl.innerHTML = '';
    const sidebarDispose = render(() => <AnalyzeSidebar />, sidebarEl);

    viewerDispose?.();
    const canvasDispose = mountAnalyzeViewer(data);
    viewerDispose = () => { headerDispose(); sidebarDispose(); canvasDispose(); };
  }

  // Expose so AnalyzeRoute can call it after the user picks a set
  window._launchAnalyze = launchViewer;

  // Clean up viewer when analyze-screen is hidden (user navigates home)
  if (analyzeScreen) {
    new MutationObserver(() => {
      if ((analyzeScreen as HTMLElement).hidden) {
        viewerDispose?.();
        viewerDispose = null;
      }
    }).observe(analyzeScreen, { attributes: true, attributeFilter: ['hidden'] });
  }
};
