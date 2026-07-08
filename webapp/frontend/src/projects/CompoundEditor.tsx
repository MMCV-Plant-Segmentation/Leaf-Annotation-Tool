/**
 * Compound editor for taxonomy v2: build/save/colour/delete saved compound labels via a
 * one-member-per-group picker with required-group enforcement.
 *
 * A compound is built by selecting one member per group (required groups MUST be chosen
 * before Save is enabled). Give it a name + colour, then Save. Deleting a compound that
 * lesions use warns first (the BE keeps lesion snapshots, so colours never vanish).
 *
 * Extracted from LabelEditor to keep each FE file under 200 lines.
 */
import { type Component, For, Show, createMemo, createSignal } from 'solid-js';
import type { Compound, Group } from './taxonomy';
import { isCompoundValid } from './taxonomy';
import { t } from '../i18n/catalog';
import * as styles from './LabelEditor.css';
import { uid, nextColor, PALETTE } from './taxonomyEditor';

type Props = {
  groups: Group[];
  compounds: Compound[];
  /** Names of compounds currently painted by some lesion (for the delete-warning). */
  usedNames: () => Set<string>;
  onChange: (compounds: Compound[]) => void;
};

const emptyDraft = (color: string): Compound => ({ id: uid(), name: '', color, selections: {} });

export const CompoundEditor: Component<Props> = (props) => {
  const [draft, setDraft] = createSignal<Compound | null>(null);
  const setCompounds = (fn: (cs: Compound[]) => Compound[]) => props.onChange(fn(props.compounds));

  const draftValid = createMemo(() => draft() !== null && isCompoundValid(draft()!, props.groups));

  const startNew = () => setDraft(emptyDraft(nextColor(props.compounds)));
  const cancel = () => setDraft(null);
  const setName = (name: string) => setDraft((d) => (d ? { ...d, name } : d));
  const setColor = (color: string) => setDraft((d) => (d ? { ...d, color } : d));
  // Selecting a member for a group toggles it (re-click clears an optional group's pick).
  const pick = (gid: string, mid: string) =>
    setDraft((d) => {
      if (!d) return d;
      const sel = { ...d.selections };
      if (sel[gid] === mid) delete sel[gid];
      else sel[gid] = mid;
      return { ...d, selections: sel };
    });

  const save = () => {
    const d = draft();
    if (!d || !d.name.trim() || !draftValid()) return;
    setCompounds((cs) => [...cs, { ...d, name: d.name.trim(), id: d.id || uid() }]);
    setDraft(null);
  };

  const remove = (id: string, name: string) => {
    if (props.usedNames().has(name)) {
      const ok = window.confirm(t('detail.labels.deleteUsedConfirm', { name }));
      if (!ok) return;
    }
    setCompounds((cs) => cs.filter((c) => c.id !== id));
  };

  return (
    <div class={styles.list}>
      <h4 class={styles.subTitle}>{t('detail.labels.compoundsTitle')}</h4>
      <For each={props.compounds}>
        {(c) => (
          <div class={styles.row} data-testid="compound-row">
            <span class={styles.compoundName} style={{ color: c.color }}>{c.name}</span>
            <button class={styles.iconBtn} classList={{ [styles.danger]: true }}
              title={t('detail.labels.remove')} data-testid="compound-remove"
              onClick={() => remove(c.id, c.name)}>✕</button>
          </div>
        )}
      </For>

      <Show when={draft()} fallback={
        <button class={styles.addBtn} data-testid="compound-add" onClick={startNew}>
          {t('detail.labels.addCompound')}
        </button>
      }>
        {(d) => (
          <div class={styles.groupBlock} data-testid="compound-draft">
            <div class={styles.row}>
              <input class={styles.color} type="color" value={d().color}
                data-testid="compound-color"
                onInput={(e) => setColor(e.currentTarget.value)} />
              <input class={styles.name} type="text" value={d().name}
                placeholder={t('detail.labels.compoundNamePlaceholder')}
                data-testid="compound-name"
                onInput={(e) => setName(e.currentTarget.value)} />
            </div>
            <For each={props.groups}>
              {(g) => (
                <div class={styles.pickerRow}>
                  <span class={styles.pickerLabel}>
                    {g.name}{g.required ? ` (${t('detail.labels.required')})` : ''}
                  </span>
                  <select data-testid="compound-picker"
                    value={d().selections[g.id] ?? ''}
                    onChange={(e) => pick(g.id, e.currentTarget.value)}>
                    <option value="">{t('detail.labels.pickNone')}</option>
                    <For each={g.members}>
                      {(m) => <option value={m.id}>{m.name}</option>}
                    </For>
                  </select>
                </div>
              )}
            </For>
            <div class={styles.actions}>
              <button class={styles.btn} disabled={!draftValid() || !d().name.trim()}
                data-testid="compound-save" onClick={save}>
                {t('detail.labels.saveCompound')}
              </button>
              <button class={styles.btn} onClick={cancel}>{t('common.cancel')}</button>
              <Show when={!draftValid() && d().name.trim()}>
                <span class={styles.err}>{t('detail.labels.invalidCompound')}</span>
              </Show>
            </div>
          </div>
        )}
      </Show>
      <Show when={draft()}>
        {/* Quick palette swatches for picking a compound colour. */}
        <div class={styles.swatches}>
          <For each={PALETTE}>
            {(hex) => (
              <button class={styles.swatchBtn} style={{ background: hex }}
                data-testid="compound-palette-swatch"
                onClick={() => setColor(hex)} aria-label={hex} />
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};

export default CompoundEditor;
