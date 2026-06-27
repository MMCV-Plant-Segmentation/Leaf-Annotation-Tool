import { type Component, createSignal, Show, onMount } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import type { PairSummary } from './lib/types';
import { t } from '../i18n/catalog';
import PairList from '../shared/PairList';
import * as pairStyles from '../shared/PairList.css';
import * as ui from '../shared/ui.css';
import { setKindClass } from '../shared/uiHelpers';

function countLabel(p: PairSummary): string {
  if (p.kind === 'merged') return p.pile_count != null ? t('common.piles', { n: p.pile_count }) : '— piles';
  return t('common.shapes', { n: p.shape_count });
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
      <Show when={!loading()} fallback={<p class={pairStyles.setupSub}>{t('analyze.loading')}</p>}>
        <Show when={pairs().length === 0}>
          <p class={pairStyles.pairEmpty}>{t('analyze.empty')}</p>
        </Show>

        <PairList
          pairs={pairs()}
          selectedId={selectedId()}
          onSelect={(p) => setSelectedId(p.id)}
          renderDetail={(p) => (
            <>
              <div class={pairStyles.pairTagsRow}>
                <span class={`${ui.setKindTag} ${setKindClass(ui, p.kind)}`}>{p.kind}</span>
                <Show when={p.terminal}>
                  <span class={`${ui.setKindTag} ${ui.setKindTerminal}`}>{t('common.locked')}</span>
                </Show>
              </div>
              <span>{countLabel(p)}</span>
            </>
          )}
        />
      </Show>

      <button
        class={ui.btnPrimary}
        style="margin-top:12px"
        disabled={!selectedId() || loading()}
        onClick={() => { const id = selectedId(); if (id) navigate(`/analyze/${id}`); }}
      >
        {t('analyze.start')}
      </button>

      <button class={ui.btnText} style="margin-top:6px" onClick={() => navigate('/')}>
        {t('common.home')}
      </button>
    </>
  );
};

export default AnalyzeSetup;
