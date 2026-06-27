import { type Component, createSignal, Show } from 'solid-js';
import type { PairSummary } from '../analyze/lib/types';
import { t } from '../i18n/catalog';
import * as styles from './ManageScreen.css';
import * as ui from '../shared/ui.css';
import * as upload from '../shared/Upload.css';

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
    setSaving(true); setStatus(t('common.saving'));
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
      <div class={upload.uploadFileRow}>
        <label class={upload.uploadFileBtn}>
          <span class={imgFile() ? '' : upload.replaceFileHint}>
            {imgFile()?.name ?? `current (.${props.pair.image_ext})`}
          </span>
          <input type="file" accept=".tif,.tiff,.png,.jpg,.jpeg"
                 onChange={e => setImgFile((e.target as HTMLInputElement).files?.[0] ?? null)} />
        </label>
        <label class={upload.uploadFileBtn}>
          <span class={jsonFile() ? '' : upload.replaceFileHint}>
            {jsonFile()?.name ?? 'current (.json)'}
          </span>
          <input type="file" accept=".json"
                 onChange={e => setJsonFile((e.target as HTMLInputElement).files?.[0] ?? null)} />
        </label>
      </div>
      <div class={styles.pairReplaceFooter}>
        <button class={ui.btnSecondary}
                disabled={saving()} onClick={save}>{t('common.save')}</button>
        <button class={ui.btnText} onClick={props.onCancel}>{t('common.cancel')}</button>
        <Show when={status()}>
          <p class={upload.uploadStatus} style="margin-left:4px">{status()}</p>
        </Show>
      </div>
    </div>
  );
};

export default ReplaceForm;
