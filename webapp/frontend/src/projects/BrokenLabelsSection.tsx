/**
 * t109: read-only "Broken labels" section — surfaces INVALID compounds (a deleted
 * required group/member, or a pre-v2/legacy painted label folded in by the
 * `0012_orphan_labels` migration) that would otherwise be invisible to this editor.
 * Each row is display-only (no rename/recolour — that's what makes it "broken"); the
 * only action is Delete, which removes it from the carried list and immediately saves,
 * hitting the EXISTING t64 referenced-delete/reassign flow (`ReassignPicker`) when the
 * label is still referenced by lesions.
 *
 * Extracted from LabelEditor to keep it under 200 lines.
 */
import { type Component, For, Show } from 'solid-js';
import type { BrokenCompound } from './taxonomy';
import { t } from '../i18n/catalog';
import * as styles from './LabelEditor.css';

type Props = {
  broken: BrokenCompound[];
  onDelete: (id: string) => void;
};

export const BrokenLabelsSection: Component<Props> = (props) => (
  <Show when={props.broken.length}>
    <div class={styles.list} data-testid="broken-labels">
      <h4 class={styles.subTitle}>{t('detail.labels.brokenTitle')}</h4>
      <For each={props.broken}>
        {(b) => (
          <div class={styles.row} data-testid="broken-row">
            <span class={styles.color} style={{ background: b.color, cursor: 'default' }} />
            <span class={styles.compoundName}>{b.name}</span>
            <span class={styles.pickerLabel}>{t('detail.labels.brokenHint')}</span>
            <button class={styles.iconBtn} classList={{ [styles.danger]: true }}
              title={t('detail.labels.remove')} data-testid="broken-remove"
              onClick={() => props.onDelete(b.id)}>✕</button>
          </div>
        )}
      </For>
    </div>
  </Show>
);

export default BrokenLabelsSection;
