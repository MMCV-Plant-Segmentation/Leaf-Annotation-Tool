import { type Component, createSignal, Show, onMount } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import type { PairSummary } from './lib/types';
import PairList from '../shared/PairList';
import pairStyles from '../shared/PairList.module.css';

function countLabel(p: PairSummary): string {
  if (p.kind === 'merged') return p.pile_count != null ? `${p.pile_count} piles` : '— piles';
  return `${p.shape_count} shapes`;
}

const AnalyzeSetup: Component = () => {
  const navigate = useNavigate();
  const [pairs,      setPairs]      = createSignal<PairSummary[]>([]);
  const [loading,    setLoading]    = createSignal(true);
  const [selectedId, setSelectedId] = createSignal<string | null>(null);

  onMount(async () => {
    const data: PairSummary[] = await fetch('/api/images').then(r => r.json());
    const eligible = data.filter(p => p.kind === 'merged' || p.kind === 'reannotated');
    setPairs(eligible);
    if (eligible.length > 0) setSelectedId(eligible[0].id);
    setLoading(false);
  });

  return (
    <>
      <Show when={!loading()} fallback={<p class={pairStyles.setupSub}>Loading…</p>}>
        <Show when={pairs().length === 0}>
          <p class={pairStyles.pairEmpty}>No merged or reannotated sets yet. Save a comparison first.</p>
        </Show>

        <PairList
          pairs={pairs()}
          selectedId={selectedId()}
          onSelect={(p) => setSelectedId(p.id)}
          renderDetail={(p) => (
            <>
              <div class={pairStyles.pairTagsRow}>
                <span class={`set-kind-tag set-kind-${p.kind}`}>{p.kind}</span>
                <Show when={p.terminal}>
                  <span class="set-kind-tag set-kind-terminal">locked</span>
                </Show>
              </div>
              <span>{countLabel(p)}</span>
            </>
          )}
        />
      </Show>

      <button
        class="btn-primary"
        style="margin-top:12px"
        disabled={!selectedId() || loading()}
        onClick={() => { const id = selectedId(); if (id) navigate(`/analyze/${id}`); }}
      >
        Analyze →
      </button>

      <button class="btn-text" style="margin-top:6px" onClick={() => navigate('/')}>
        ← Home
      </button>
    </>
  );
};

export default AnalyzeSetup;
