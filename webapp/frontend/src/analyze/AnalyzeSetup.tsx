import { Component, createSignal, For, Show } from 'solid-js';
import { Root as ListboxRoot, Item as ListboxItem } from '@kobalte/core/listbox';
import { useNavigate } from '@solidjs/router';
import type { AnalyzeData, PairSummary } from './lib/types';
import { getAvailablePairs } from './lib/bridge';
import { fetchAnalyze } from './lib/api';
import pairStyles from '../shared/PairList.module.css';

function countLabel(p: PairSummary): string {
  if (p.kind === 'merged') return p.pile_count != null ? `${p.pile_count} piles` : '— piles';
  return `${p.shape_count} shapes`;
}

interface Props {
  onData: (data: AnalyzeData) => void;
}

const AnalyzeSetup: Component<Props> = (props) => {
  const navigate = useNavigate();
  const eligible = getAvailablePairs().filter(
    p => p.kind === 'merged' || p.kind === 'reannotated',
  );

  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

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
        <p class={pairStyles.pairEmpty}>No merged or reannotated sets yet. Save a comparison first.</p>
      </Show>

      <ListboxRoot
        as="div"
        options={eligible}
        optionValue="id"
        optionTextValue="display_name"
        value={selectedId() ? [selectedId()!] : []}
        onChange={(set: Set<string>) => {
          const id = [...set][0];
          if (id) setSelectedId(id);
        }}
        renderItem={(node: any) => (
          <ListboxItem item={node} as="div" class={pairStyles.pairItem} data-id={node.rawValue.id}>
            <div class={pairStyles.pairItemLeft}>
              <strong>{node.rawValue.display_name}</strong>
              <div class={pairStyles.pairTagsRow}>
                <span class={`set-kind-tag set-kind-${node.rawValue.kind}`}>{node.rawValue.kind}</span>
                <Show when={node.rawValue.terminal}>
                  <span class="set-kind-tag set-kind-terminal">locked</span>
                </Show>
              </div>
              <span>{countLabel(node.rawValue)}</span>
            </div>
          </ListboxItem>
        )}
      />

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
        onClick={() => navigate('/')}
      >
        ← Home
      </button>
    </>
  );
};

export default AnalyzeSetup;
