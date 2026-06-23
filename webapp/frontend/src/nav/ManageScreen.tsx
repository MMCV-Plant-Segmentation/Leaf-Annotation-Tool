import { Component, createSignal, For, Show, onMount } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { Root as DialogRoot, Portal as DialogPortal, Overlay as DialogOverlay,
         Content as DialogContent, Title as DialogTitle } from '@kobalte/core/dialog';
import type { PairSummary } from '../analyze/lib/types';
import styles from './ManageScreen.module.css';
import pairStyles from '../shared/PairList.module.css';

function countLabel(p: PairSummary) {
  if (p.kind === 'merged') return p.pile_count != null ? `${p.pile_count} piles` : '— piles';
  return `${p.shape_count} shapes`;
}

// ── Replace-files sub-form ────────────────────────────────────────────────────
const ReplaceForm: Component<{
  pair: PairSummary;
  onDone: (updated: PairSummary) => void;
  onCancel: () => void;
}> = (props) => {
  const [imgFile, setImgFile]   = createSignal<File | null>(null);
  const [jsonFile, setJsonFile] = createSignal<File | null>(null);
  const [saving, setSaving]     = createSignal(false);
  const [status, setStatus]     = createSignal('');

  async function save() {
    if (!imgFile() && !jsonFile()) { setStatus('Select at least one file.'); return; }
    setSaving(true); setStatus('Saving…');
    const fd = new FormData();
    if (imgFile())  fd.append('image', imgFile()!);
    if (jsonFile()) fd.append('json',  jsonFile()!);
    try {
      const r = await fetch(`/api/images/${encodeURIComponent(props.pair.id)}`,
                            { method: 'PUT', body: fd });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error ?? 'Replace failed'); }
      props.onDone(await r.json());
    } catch (e: any) {
      setStatus(e.message);
      setSaving(false);
    }
  }

  return (
    <div class={styles.pairReplaceForm}>
      <div class="upload-file-row">
        <label class="upload-file-btn">
          <span class={imgFile() ? '' : 'replace-file-hint'}>
            {imgFile()?.name ?? `current (.${props.pair.image_ext})`}
          </span>
          <input type="file" accept=".tif,.tiff,.png,.jpg,.jpeg"
                 onChange={e => setImgFile((e.target as HTMLInputElement).files?.[0] ?? null)} />
        </label>
        <label class="upload-file-btn">
          <span class={jsonFile() ? '' : 'replace-file-hint'}>
            {jsonFile()?.name ?? 'current (.json)'}
          </span>
          <input type="file" accept=".json"
                 onChange={e => setJsonFile((e.target as HTMLInputElement).files?.[0] ?? null)} />
        </label>
      </div>
      <div class={styles.pairReplaceFooter}>
        <button class="btn-secondary" style="flex:none;padding:5px 14px"
                disabled={saving()} onClick={save}>Save</button>
        <button class="btn-text" onClick={props.onCancel}>Cancel</button>
        <Show when={status()}>
          <p class="upload-status" style="margin-left:4px">{status()}</p>
        </Show>
      </div>
    </div>
  );
};

// ── Manage screen ─────────────────────────────────────────────────────────────
const ManageScreen: Component = () => {
  const navigate = useNavigate();
  const [pairs,      setPairs]      = createSignal<PairSummary[]>([]);
  const [loading,    setLoading]    = createSignal(true);
  const [renamingId, setRenamingId] = createSignal<string | null>(null);
  const [renameVal,  setRenameVal]  = createSignal('');
  const [deletingId, setDeletingId] = createSignal<string | null>(null);
  const [replacingId, setReplacingId] = createSignal<string | null>(null);
  const [showAdd,    setShowAdd]    = createSignal(false);
  const [addName,    setAddName]    = createSignal('');
  const [addImg,     setAddImg]     = createSignal<File | null>(null);
  const [addJson,    setAddJson]    = createSignal<File | null>(null);
  const [addStatus,  setAddStatus]  = createSignal('');
  const [uploading,  setUploading]  = createSignal(false);

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

  async function upload() {
    if (!addName().trim() || !addImg() || !addJson()) {
      setAddStatus('Display name, image, and JSON are all required.'); return;
    }
    setUploading(true); setAddStatus('Uploading…');
    const fd = new FormData();
    fd.append('image', addImg()!);
    fd.append('json',  addJson()!);
    fd.append('display_name', addName().trim());
    try {
      const r = await fetch('/api/upload', { method: 'POST', body: fd });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error ?? 'Upload failed'); }
      const newPair = await r.json();
      const next = [...pairs(), newPair];
      setPairs(next); syncGlobal(next);
      setShowAdd(false); setAddName(''); setAddImg(null); setAddJson(null); setAddStatus('');
    } catch (e: any) {
      setAddStatus(e.message);
    } finally {
      setUploading(false);
    }
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
        <div style="display:flex;flex-direction:column;gap:8px;margin-top:10px;padding:12px;background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:var(--radius)">
          <input type="text" class="text-input" placeholder="Display name"
                 value={addName()}
                 onInput={e => setAddName((e.target as HTMLInputElement).value)} />
          <div class="upload-file-row">
            <label class="upload-file-btn">
              <span>{addImg()?.name ?? 'Image…'}</span>
              <input type="file" accept=".tif,.tiff,.png,.jpg,.jpeg"
                     onChange={e => setAddImg((e.target as HTMLInputElement).files?.[0] ?? null)} />
            </label>
            <label class="upload-file-btn">
              <span>{addJson()?.name ?? 'JSON…'}</span>
              <input type="file" accept=".json"
                     onChange={e => setAddJson((e.target as HTMLInputElement).files?.[0] ?? null)} />
            </label>
          </div>
          <button class="btn-secondary" style="width:100%" disabled={uploading()} onClick={upload}>
            {uploading() ? 'Uploading…' : 'Upload'}
          </button>
          <Show when={addStatus()}>
            <p class="upload-status"
               style={addStatus().includes('fail') || addStatus().includes('required')
                        ? 'color:var(--fail)' : ''}>
              {addStatus()}
            </p>
          </Show>
          <button class="btn-text" style="margin-top:2px"
                  onClick={() => { setShowAdd(false); setAddStatus(''); }}>← Cancel</button>
        </div>
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
