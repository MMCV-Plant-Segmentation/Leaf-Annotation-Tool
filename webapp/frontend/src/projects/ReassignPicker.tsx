/**
 * t64 delete-reassign: shown ONLY after a taxonomy save is rejected because it drops a
 * compound that existing lesions still reference (backend PATCH /api/projects/:id ->
 * 409 `{error, blockedCompoundId}`). The user picks another SURVIVING compound to move
 * those lesions to; confirming resubmits the same save with `reassignCompounds:
 * {blockedId: targetId}`. Deleting an UNREFERENCED compound never reaches this — no
 * ceremony (see webapp/projects.py update_project, C4/C5/C6).
 *
 * Extracted from LabelEditor to keep it under 200 lines.
 */
import { type Component, For, createSignal } from 'solid-js';
import type { Compound } from './taxonomy';
import { t } from '../i18n/catalog';
import * as styles from './LabelEditor.css';

type Props = {
  /** The compound that was blocked (its NAME, for the message — it's already gone from `compounds`). */
  blockedName: string;
  /** The compounds the new taxonomy WOULD save with — the valid reassignment targets. */
  compounds: Compound[];
  onConfirm: (targetId: string) => void;
  onCancel: () => void;
};

export const ReassignPicker: Component<Props> = (props) => {
  const [target, setTarget] = createSignal('');

  return (
    <div class={styles.groupBlock} data-testid="reassign-picker">
      <strong>{t('detail.labels.reassignTitle', { name: props.blockedName })}</strong>
      <span class={styles.pickerLabel}>
        {t('detail.labels.reassignPrompt', { name: props.blockedName })}
      </span>
      <select data-testid="reassign-target" value={target()}
        onChange={(e) => setTarget(e.currentTarget.value)}>
        <option value="">{t('detail.labels.reassignPick')}</option>
        <For each={props.compounds}>
          {(c) => <option value={c.id}>{c.name}</option>}
        </For>
      </select>
      <div class={styles.actions}>
        <button class={styles.btn} disabled={!target()} data-testid="reassign-confirm"
          onClick={() => target() && props.onConfirm(target())}>
          {t('detail.labels.reassignConfirm')}
        </button>
        <button class={styles.btn} data-testid="reassign-cancel" onClick={props.onCancel}>
          {t('common.cancel')}
        </button>
      </div>
    </div>
  );
};

export default ReassignPicker;
