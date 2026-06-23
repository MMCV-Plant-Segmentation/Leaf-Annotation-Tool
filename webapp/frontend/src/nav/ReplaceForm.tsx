import { type Component, createSignal, Show } from 'solid-js';
import type { PairSummary } from '../analyze/lib/types';
import styles from './ManageScreen.module.css';

const ReplaceForm: Component<{
  pair: PairSummary;
  onDone: (updated: PairSummary) => void;
  onCancel: () => void;
}> = (props) => {
  const [imgFile,  setImgFile]  = createSignal<File | null>(null);
  const [jsonFile, setJsonFile] = createSignal<File | null>(null);
  const [saving,   setSaving]   = createSignal(false);
  const [status,   setStatus]   = createSignal('');

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

export default ReplaceForm;
