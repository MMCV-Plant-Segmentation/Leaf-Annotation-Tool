import { type Component, createSignal, Show } from 'solid-js';
import type { PairSummary } from '../analyze/lib/types';
import ui from '../shared/ui.module.css';
import upload from '../shared/Upload.module.css';

const AddSetForm: Component<{
  onDone: (pair: PairSummary) => void;
  onCancel: () => void;
}> = (props) => {
  const [name,      setName]      = createSignal('');
  const [img,       setImg]       = createSignal<File | null>(null);
  const [json,      setJson]      = createSignal<File | null>(null);
  const [status,    setStatus]    = createSignal('');
  const [uploading, setUploading] = createSignal(false);

  async function upload() {
    if (!name().trim() || !img() || !json()) {
      setStatus('Display name, image, and JSON are all required.'); return;
    }
    setUploading(true); setStatus('Uploading…');
    const fd = new FormData();
    fd.append('image', img()!);
    fd.append('json',  json()!);
    fd.append('display_name', name().trim());
    try {
      const r = await fetch('/api/upload', { method: 'POST', body: fd });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error ?? 'Upload failed'); }
      props.onDone(await r.json());
    } catch (e: any) {
      setStatus(e.message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div style="display:flex;flex-direction:column;gap:8px;margin-top:10px;padding:12px;background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:var(--radius)">
      <input type="text" class={ui.textInput} placeholder="Display name"
             value={name()}
             onInput={e => setName((e.target as HTMLInputElement).value)} />
      <div class={upload.uploadFileRow}>
        <label class={upload.uploadFileBtn}>
          <span>{img()?.name ?? 'Image…'}</span>
          <input type="file" accept=".tif,.tiff,.png,.jpg,.jpeg"
                 onChange={e => setImg((e.target as HTMLInputElement).files?.[0] ?? null)} />
        </label>
        <label class={upload.uploadFileBtn}>
          <span>{json()?.name ?? 'JSON…'}</span>
          <input type="file" accept=".json"
                 onChange={e => setJson((e.target as HTMLInputElement).files?.[0] ?? null)} />
        </label>
      </div>
      <button class={ui.btnSecondary} style="width:100%" disabled={uploading()} onClick={upload}>
        {uploading() ? 'Uploading…' : 'Upload'}
      </button>
      <Show when={status()}>
        <p class={upload.uploadStatus}
           style={status().includes('fail') || status().includes('required') ? 'color:var(--fail)' : ''}>
          {status()}
        </p>
      </Show>
      <button class={ui.btnText} style="margin-top:2px" onClick={props.onCancel}>← Cancel</button>
    </div>
  );
};

export default AddSetForm;
