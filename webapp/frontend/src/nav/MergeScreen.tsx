import { Component, createSignal, For, Show, onMount } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { Root as CheckboxRoot, Control as CheckboxControl, Indicator as CheckboxIndicator }
  from '@kobalte/core/checkbox';
import { Root as ListboxRoot, Item as ListboxItem } from '@kobalte/core/listbox';
import type { PairSummary } from '../analyze/lib/types';
import styles from './MergeScreen.module.css';
import pairStyles from '../shared/PairList.module.css';

interface CompareSession {
  imageHash: string;
  includedSetIds: string[];
  piles: Record<string, unknown>;
}

function countLabel(p: PairSummary) {
  if (p.kind === 'merged') return p.pile_count != null ? `${p.pile_count} piles` : '— piles';
  return `${p.shape_count} shapes`;
}

const w = window as any;

const MergeScreen: Component = () => {
  const navigate = useNavigate();
  const [pairs,        setPairs]        = createSignal<PairSummary[]>([]);
  const [loading,      setLoading]      = createSignal(true);
  const [view,         setView]         = createSignal<'fork' | 'setup'>('setup');
  const [savedSession, setSavedSession] = createSignal<CompareSession | null>(null);
  const [selectedHash, setSelectedHash] = createSignal<string | null>(null);
  const [selectedIds,  setSelectedIds]  = createSignal<string[]>([]);
  const [seeding,      setSeeding]      = createSignal(false);
  const [seedError,    setSeedError]    = createSignal('');

  const byHash = () => {
    const map: Record<string, PairSummary[]> = {};
    for (const p of pairs()) (map[p.image_hash] = map[p.image_hash] || []).push(p);
    return map;
  };

  onMount(async () => {
    const data: PairSummary[] = await fetch('/api/images').then(r => r.json());
    setPairs(data);
    setLoading(false);
    w.availablePairs = data; // readCompareSession validates against this global

    const saved: CompareSession | null = (await w._readCompareSession?.()) ?? null;
    if (saved) { setSavedSession(saved); setView('fork'); }
  });

  function selectHash(hash: string) {
    setSelectedHash(hash);
    setSelectedIds(pairs().filter(p => p.image_hash === hash).map(p => p.id));
  }

  function toggleId(id: string) {
    setSelectedIds(ids => ids.includes(id) ? ids.filter(i => i !== id) : [...ids, id]);
  }

  async function launchNew() {
    const hash = selectedHash();
    const setIds = selectedIds();
    if (!hash || setIds.length === 0 || seeding()) return;
    setSeeding(true); setSeedError('');
    try {
      await w._launchNewCompare?.(hash, setIds);
    } catch (e: any) {
      setSeedError(e?.message ?? 'Something went wrong'); setSeeding(false);
    }
  }

  async function deleteSession() {
    await w._deleteCompare?.();
    setSavedSession(null); setView('setup');
  }

  function forkInfo() {
    const s = savedSession();
    if (!s) return '';
    const imgPair = pairs().find(p => p.image_hash === s.imageHash);
    const imgName = imgPair ? imgPair.display_name : s.imageHash.slice(0, 8) + '…';
    const nPiles  = Object.keys(s.piles || {}).length;
    return `<strong>${imgName}</strong><br>${s.includedSetIds.length} annotation sets · ${nPiles} piles`;
  }

  return (
    <>
      {/* ── Fork view ── */}
      <Show when={view() === 'fork'}>
        <div class={pairStyles.resumeInfo} innerHTML={forkInfo()} />
        <button class="btn-primary" style="margin-top:10px"
                onClick={() => w._resumeCompare?.(savedSession())}>
          Continue comparison
        </button>
        <button class="btn-secondary" style="width:100%;margin-top:8px"
                onClick={() => { setSavedSession(null); setView('setup'); }}>
          New comparison →
        </button>
        <button class="btn-text" style="margin-top:4px;color:var(--fail)"
                onClick={deleteSession}>
          ✕ Delete saved comparison
        </button>
        <button class="btn-text" style="margin-top:8px" onClick={() => navigate('/')}>← Home</button>
      </Show>

      {/* ── Setup view ── */}
      <Show when={view() === 'setup'}>
        <Show when={!loading()} fallback={<p class={pairStyles.setupSub}>Loading…</p>}>
          <p class={pairStyles.setupSub}>Image</p>

          <Show when={Object.keys(byHash()).length === 0}>
            <p class={pairStyles.pairEmpty}>No annotation sets yet.</p>
          </Show>

          <ListboxRoot
            as="div"
            options={Object.entries(byHash()).map(([hash, ps]) => ({ hash, ps }))}
            optionValue="hash"
            optionTextValue={(g: any) => g.ps[0].display_name}
            value={selectedHash() ? [selectedHash()!] : []}
            onChange={(set: Set<string>) => {
              const hash = [...set][0];
              if (hash) selectHash(hash);
            }}
            renderItem={(node: any) => (
              <ListboxItem item={node} as="div" class={pairStyles.pairItem} data-hash={node.rawValue.hash}>
                <div class={pairStyles.pairItemLeft}>
                  <strong>{node.rawValue.ps[0].display_name}</strong>
                  <span>{node.rawValue.ps.length} annotation set{node.rawValue.ps.length !== 1 ? 's' : ''}</span>
                </div>
              </ListboxItem>
            )}
          />

          <Show when={selectedHash()}>
            <>
              <p class={pairStyles.setupSub} style="margin-top:14px">Annotation sets</p>
              <For each={pairs().filter(p => p.image_hash === selectedHash())}>
                {(p) => (
                  <CheckboxRoot
                    class={styles.compareSetRow}
                    checked={selectedIds().includes(p.id)}
                    onChange={() => toggleId(p.id)}
                  >
                    <CheckboxControl class={styles.checkCtrl}>
                      <CheckboxIndicator class={styles.checkIndicator}>✓</CheckboxIndicator>
                    </CheckboxControl>
                    {` ${p.display_name} (${countLabel(p)})`}
                  </CheckboxRoot>
                )}
              </For>
            </>
          </Show>

          <Show when={seedError()}>
            <p style="color:var(--fail);font-size:0.82rem;margin-top:8px">{seedError()}</p>
          </Show>

          <button
            class="btn-primary" style="margin-top:12px"
            disabled={!selectedHash() || selectedIds().length === 0 || seeding()}
            onClick={launchNew}
          >
            {seeding() ? 'Loading…' : 'Continue →'}
          </button>
          <button class="btn-text" style="margin-top:6px" onClick={() => navigate('/')}>← Home</button>
        </Show>
      </Show>
    </>
  );
};

export default MergeScreen;
