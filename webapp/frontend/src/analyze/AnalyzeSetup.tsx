import { Component, createSignal, For, Show, onMount, onCleanup } from 'solid-js';
import type { AnalyzeData, PairSummary } from './lib/types';
import { getAvailablePairs, showHomeScreen } from './lib/bridge';
import { fetchAnalyze } from './lib/api';

function countLabel(p: PairSummary): string {
  if (p.kind === 'merged') return p.pile_count != null ? `${p.pile_count} piles` : '— piles';
  return `${p.shape_count} shapes`;
}

interface Props {
  onData: (data: AnalyzeData) => void;
}

const AnalyzeSetup: Component<Props> = (props) => {
  const eligible = getAvailablePairs().filter(
    p => p.kind === 'merged' || p.kind === 'reannotated',
  );

  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  // Hide the vanilla Go/Home buttons while Solid owns the setup UI
  onMount(() => {
    document.getElementById('analyze-go-btn')!.style.display = 'none';
    document.getElementById('home-btn-analyze')!.style.display = 'none';
  });
  onCleanup(() => {
    document.getElementById('analyze-go-btn')!.style.display = '';
    document.getElementById('home-btn-analyze')!.style.display = '';
  });

  async function handleGo() {
    const id = selectedId();
    if (!id || loading()) return;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchAnalyze(id);
      props.onData(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setLoading(false);
    }
  }

  return (
    <>
      <Show when={eligible.length === 0}>
        <p class="pair-empty">No merged or reannotated sets yet. Save a comparison first.</p>
      </Show>

      <For each={eligible}>
        {(p) => (
          <div
            class={`pair-item${selectedId() === p.id ? ' selected' : ''}`}
            data-id={p.id}
            onClick={() => setSelectedId(p.id)}
          >
            <div class="pair-item-left">
              <strong class="pair-name">{p.display_name}</strong>
              <div class="pair-tags-row">
                <span class={`set-kind-tag set-kind-${p.kind}`}>{p.kind}</span>
                <Show when={p.terminal}>
                  <span class="set-kind-tag set-kind-terminal">locked</span>
                </Show>
              </div>
              <span>{countLabel(p)}</span>
            </div>
          </div>
        )}
      </For>

      <Show when={error()}>
        <p style="color:var(--danger,#f03e3e);font-size:0.82rem;margin-top:8px">{error()}</p>
      </Show>

      <button
        class="btn-primary"
        style="margin-top:12px"
        disabled={!selectedId() || loading()}
        onClick={handleGo}
      >
        {loading() ? 'Loading…' : 'Analyze →'}
      </button>

      <button
        class="btn-text"
        style="margin-top:6px"
        onClick={showHomeScreen}
      >
        ← Home
      </button>
    </>
  );
};

export default AnalyzeSetup;
