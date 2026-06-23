import { type Component, createSignal, For, Show, onMount } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { Root as DialogRoot, Portal as DialogPortal, Overlay as DialogOverlay,
         Content as DialogContent, Title as DialogTitle } from '@kobalte/core/dialog';
import type { PairSummary } from '../analyze/lib/types';
import ReplaceForm from './ReplaceForm';
import AddSetForm from './AddSetForm';
import styles from './ManageScreen.module.css';
import pairStyles from '../shared/PairList.module.css';

function countLabel(p: PairSummary) {
  if (p.kind === 'merged') return p.pile_count != null ? `${p.pile_count} piles` : '— piles';
  return `${p.shape_count} shapes`;
}

const ManageScreen: Component = () => {
  const navigate = useNavigate();
  const [pairs,       setPairs]       = createSignal<PairSummary[]>([]);
  const [loading,     setLoading]     = createSignal(true);
  const [renamingId,  setRenamingId]  = createSignal<string | null>(null);
  const [renameVal,   setRenameVal]   = createSignal('');
  const [deletingId,  setDeletingId]  = createSignal<string | null>(null);
  const [replacingId, setReplacingId] = createSignal<string | null>(null);
  const [showAdd,     setShowAdd]     = createSignal(false);

  onMount(async () => {
    const data = await fetch('/api/images').then(r => r.json());
    setPairs(data);
    setLoading(false);
  });

  function syncGlobal(updated: PairSummary[]) {
    (window as any).availablePairs = updated;
  }

  async function saveRename(p: PairSummary) {
    const name = renameVal().trim();
    if (name && name !== p.display_name) {
      await fetch(`/api/images/${encodeURIComponent(p.id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: name }),
      });
      const next = pairs().map(q => q.id === p.id ? { ...q, display_name: name } : q);
      setPairs(next); syncGlobal(next);
    }
    setRenamingId(null);
  }

  async function confirmDelete(id: string) {
    await fetch(`/api/images/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const next = pairs().filter(q => q.id !== id);
    setPairs(next); syncGlobal(next);
    setDeletingId(null);
  }

  return (
    <>
      <p class={pairStyles.setupSub}>Annotation sets</p>

      <Show when={!loading()} fallback={<p class={pairStyles.setupSub}>Loading…</p>}>
        <Show when={pairs().length === 0}>
          <p class={pairStyles.pairEmpty}>No annotation sets yet. Click "+ Add" below.</p>
        </Show>

        <For each={pairs()}>
          {(p) => (
            <div class={styles.pairEntry}>
              <div class={`${pairStyles.pairItem}${replacingId() === p.id ? ' ' + pairStyles.pairItemReplacing : ''}`} data-id={p.id}>
                <div class={pairStyles.pairItemLeft}>
                  <Show when={renamingId() !== p.id}
                    fallback={
                      <input
                        type="text" class="pair-rename-input"
                        value={renameVal()}
                        onInput={e => setRenameVal((e.target as HTMLInputElement).value)}
                        onBlur={() => saveRename(p)}
                        onKeyDown={e => {
                          if (e.key === 'Enter')  { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
                          if (e.key === 'Escape') { setRenamingId(null); }
                        }}
                        ref={el => setTimeout(() => { el.focus(); el.select(); }, 0)}
                      />
                    }
                  >
                    <strong>{p.display_name}</strong>
                  </Show>
                  <div class={pairStyles.pairTagsRow}>
                    <span class={`set-kind-tag set-kind-${p.kind}`}>{p.kind}</span>
                    <Show when={p.terminal}>
                      <span class="set-kind-tag set-kind-terminal">locked</span>
                    </Show>
                  </div>
                  <span style="font-size:0.75rem;color:var(--muted)">{countLabel(p)}</span>
                </div>

                <Show when={renamingId() !== p.id}>
                  <div class={pairStyles.pairActionBtns}>
                    <button class="pair-edit-btn" title="Rename"
                      onClick={() => { setRenamingId(p.id); setRenameVal(p.display_name); }}>✎</button>
                    <Show when={p.kind !== 'merged'}>
                      <button class="pair-replace-btn" title="Replace files"
                        onClick={() => setReplacingId(id => id === p.id ? null : p.id)}>↻</button>
                    </Show>
                    <button class="pair-delete-btn" title="Delete"
                      onClick={() => setDeletingId(p.id)}>✕</button>
                  </div>
                </Show>
              </div>

              <Show when={replacingId() === p.id}>
                <ReplaceForm
                  pair={p}
                  onDone={updated => {
                    const next = pairs().map(q => q.id === updated.id ? updated : q);
                    setPairs(next); syncGlobal(next);
                    setReplacingId(null);
                  }}
                  onCancel={() => setReplacingId(null)}
                />
              </Show>
            </div>
          )}
        </For>
      </Show>

      <Show when={showAdd()}>
        <AddSetForm
          onDone={newPair => {
            const next = [...pairs(), newPair];
            setPairs(next); syncGlobal(next);
            setShowAdd(false);
          }}
          onCancel={() => setShowAdd(false)}
        />
      </Show>

      <Show when={!showAdd()}>
        <button class="btn-text" style="margin-top:10px" onClick={() => setShowAdd(true)}>
          + Add new annotation set
        </button>
      </Show>
      <button class="btn-text" style="margin-top:8px" onClick={() => navigate('/')}>← Home</button>

      <DialogRoot open={!!deletingId()} onOpenChange={v => { if (!v) setDeletingId(null); }}>
        <DialogPortal>
          <DialogOverlay class={styles.backdrop} />
          <DialogContent class={styles.panel}>
            <DialogTitle class={styles.title}>Delete annotation set?</DialogTitle>
            <p class={styles.sub}>
              {pairs().find(p => p.id === deletingId())?.display_name}
            </p>
            <div style="display:flex;gap:8px;margin-top:4px">
              <button class="btn-secondary" style="flex:none"
                onClick={() => { const id = deletingId(); if (id) confirmDelete(id); }}>
                Delete
              </button>
              <button class="btn-text" onClick={() => setDeletingId(null)}>Cancel</button>
            </div>
          </DialogContent>
        </DialogPortal>
      </DialogRoot>
    </>
  );
};

export default ManageScreen;
