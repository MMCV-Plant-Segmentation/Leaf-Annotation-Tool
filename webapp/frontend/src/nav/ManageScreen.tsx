import { type Component, createSignal, For, Show, onMount } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { Root as DialogRoot, Portal as DialogPortal, Overlay as DialogOverlay,
         Content as DialogContent, Title as DialogTitle } from '@kobalte/core/dialog';
import type { PairSummary } from '../analyze/lib/types';
import { t } from '../i18n/catalog';
import ReplaceForm from './ReplaceForm';
import AddSetForm from './AddSetForm';
import * as styles from './ManageScreen.css';
import * as pairStyles from '../shared/PairList.css';
import * as ui from '../shared/ui.css';
import { setKindClass } from '../shared/uiHelpers';

function countLabel(p: PairSummary) {
  if (p.kind === 'merged') return p.pile_count != null ? t('common.piles', { n: p.pile_count }) : '— piles';
  return t('common.shapes', { n: p.shape_count });
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
      <p class={pairStyles.setupSub}>{t('manage.title')}</p>

      <Show when={!loading()} fallback={<p class={pairStyles.setupSub}>{t('common.loading')}</p>}>
        <Show when={pairs().length === 0}>
          <p class={pairStyles.pairEmpty}>{t('manage.empty')}</p>
        </Show>

        <For each={pairs()}>
          {(p) => (
            <div class={styles.pairEntry}>
              <div class={`${pairStyles.pairItem}${replacingId() === p.id ? ' ' + pairStyles.pairItemReplacing : ''}`} data-id={p.id}>
                <div class={pairStyles.pairItemLeft}>
                  <Show when={renamingId() !== p.id}
                    fallback={
                      <input
                        type="text" class={styles.pairRenameInput}
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
                    <span class={`${ui.setKindTag} ${setKindClass(ui, p.kind)}`}>{p.kind}</span>
                    <Show when={p.terminal}>
                      <span class={`${ui.setKindTag} ${ui.setKindTerminal}`}>{t('common.locked')}</span>
                    </Show>
                  </div>
                  <span style="font-size:0.75rem;color:var(--muted)">{countLabel(p)}</span>
                </div>

                <Show when={renamingId() !== p.id}>
                  <div class={pairStyles.pairActionBtns}>
                    <button class={styles.pairEditBtn} title={t('manage.btn.rename')}
                      onClick={() => { setRenamingId(p.id); setRenameVal(p.display_name); }}>✎</button>
                    <Show when={p.kind !== 'merged'}>
                      <button class={styles.pairReplaceBtn} title={t('manage.btn.replace')}
                        onClick={() => setReplacingId(id => id === p.id ? null : p.id)}>↻</button>
                    </Show>
                    <button class={styles.pairDeleteBtn} title={t('manage.btn.delete')}
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
        <button class={ui.btnText} style="margin-top:10px" onClick={() => setShowAdd(true)}>
          {t('manage.addBtn')}
        </button>
      </Show>
      <button class={ui.btnText} style="margin-top:8px" onClick={() => navigate('/')}>{t('common.home')}</button>

      <DialogRoot open={!!deletingId()} onOpenChange={v => { if (!v) setDeletingId(null); }}>
        <DialogPortal>
          <DialogOverlay class={styles.backdrop} />
          <DialogContent class={styles.panel}>
            <DialogTitle class={styles.title}>{t('manage.delete.title')}</DialogTitle>
            <p class={styles.sub}>
              {pairs().find(p => p.id === deletingId())?.display_name}
            </p>
            <div style="display:flex;gap:8px;margin-top:4px">
              <button class={ui.btnSecondary} style="flex:none;padding:5px 14px"
                onClick={() => { const id = deletingId(); if (id) confirmDelete(id); }}>
                {t('manage.delete.confirm')}
              </button>
              <button class={ui.btnText} onClick={() => setDeletingId(null)}>{t('common.cancel')}</button>
            </div>
          </DialogContent>
        </DialogPortal>
      </DialogRoot>
    </>
  );
};

export default ManageScreen;
