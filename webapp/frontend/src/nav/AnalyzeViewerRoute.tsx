import { type Component, createSignal, onMount, onCleanup, Show } from 'solid-js';
import { useParams, useNavigate } from '@solidjs/router';
import { render } from 'solid-js/web';
import AnalyzeHeader from '../analyze/AnalyzeHeader';
import AnalyzeSidebar from '../analyze/AnalyzeSidebar';
import { mountAnalyzeViewer } from '../analyze/analyzeViewer';
import { initStore } from '../analyze/store';
import { fetchAnalyze } from '../analyze/lib/api';
import pairStyles from '../shared/PairList.module.css';

const AnalyzeViewerRoute: Component = () => {
  const params   = useParams<{ setId: string }>();
  const navigate = useNavigate();
  const [error, setError] = createSignal<string | null>(null);
  const [loaded, setLoaded] = createSignal(false);

  let disposeViewer: (() => void) | null = null;
  let screenShown = false;
  let active = true;

  onMount(async () => {
    try {
      const data = await fetchAnalyze(params.setId);
      if (!active) return;

      document.getElementById('setup-screen')!.hidden   = true;
      document.getElementById('analyze-screen')!.hidden = false;
      document.getElementById('analyze-set-name')!.textContent = data.displayName;
      screenShown = true;

      const w = window as any;
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

      const canvasDispose = mountAnalyzeViewer(data);
      disposeViewer = () => { headerDispose(); sidebarDispose(); canvasDispose(); };
      setLoaded(true);
    } catch (e) {
      if (!active) return;
      setError(e instanceof Error ? e.message : String(e));
    }
  });

  onCleanup(() => {
    active = false;
    disposeViewer?.();
    if (screenShown) {
      (document.getElementById('analyze-screen') as HTMLElement).hidden = true;
      document.getElementById('setup-screen')!.hidden = false;
    }
  });

  return (
    <Show
      when={error()}
      fallback={<Show when={!loaded()}><p class={pairStyles.setupSub}>Loading…</p></Show>}
    >
      <p style="color:var(--fail);font-size:0.82rem">{error()}</p>
      <button class="btn-text" onClick={() => navigate('/analyze')}>← Back to picker</button>
    </Show>
  );
};

export default AnalyzeViewerRoute;
