/**
 * Compound editor for taxonomy v2: build/save/colour/delete saved compound labels via a
 * one-member-per-group picker with required-group enforcement.
 *
 * A compound is built by selecting one member per group (required groups MUST be chosen
 * before Save is enabled). Give it a name + colour, then Save. Deleting a compound that
 * lesions use warns first (the BE keeps lesion snapshots, so colours never vanish).
 *
 * t64: a SAVED compound's composition is immutable — editing an EXISTING compound (its id
 * is already in `props.compounds`) only exposes name + colour; its member selections
 * render read-only. Changing composition means starting a brand-new compound (a fresh
 * id). The backend enforces this too (webapp.taxonomy.coerce_taxonomy); this is the
 * matching FE affordance so a locked field is never even offered.
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

/** The member NAMEs a compound's selections resolve to (locked read-only summary). */
const selectionNames = (c: Compound, groups: Group[]): string[] =>
  groups
    .map((g) => g.members.find((m) => m.id === c.selections[g.id])?.name)
    .filter((n): n is string => !!n);

export const CompoundEditor: Component<Props> = (props) => {
  const [draft, setDraft] = createSignal<Compound | null>(null);
  const setCompounds = (fn: (cs: Compound[]) => Compound[]) => props.onChange(fn(props.compounds));

  // A draft edits an EXISTING saved compound (composition locked) vs a brand-new one
  // (full picker) — decided by whether its id is already in the saved set.
  const isExisting = createMemo(() => {
    const d = draft();
    return !!d && props.compounds.some((c) => c.id === d.id);
  });
  const draftValid = createMemo(() => draft() !== null && isCompoundValid(draft()!, props.groups));

  const startNew = () => setDraft(emptyDraft(nextColor(props.compounds)));
  const startEdit = (c: Compound) => setDraft({ ...c, selections: { ...c.selections } });
  const cancel = () => setDraft(null);
  const setName = (name: string) => setDraft((d) => (d ? { ...d, name } : d));
  const setColor = (color: string) => setDraft((d) => (d ? { ...d, color } : d));
  // Selecting a member for a group toggles it (re-click clears an optional group's pick).
  // Only reachable for a NEW compound — the picker isn't rendered when isExisting().
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
    const saved = { ...d, name: d.name.trim(), id: d.id || uid() };
    setCompounds((cs) => (isExisting() ? cs.map((c) => (c.id === saved.id ? saved : c)) : [...cs, saved]));
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
            <button class={styles.iconBtn} title={t('detail.labels.compoundEdit')}
              data-testid="compound-edit" onClick={() => startEdit(c)}>✎</button>
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
            <Show when={isExisting()} fallback={
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
            }>
              {/* t64 C3: composition locked — read-only summary, no picker offered. */}
              <span class={styles.pickerLabel} data-testid="compound-locked-selections">
                {selectionNames(d(), props.groups).join(', ')}
              </span>
              <span class={styles.pickerLabel}>{t('detail.labels.compositionLocked')}</span>
            </Show>
            <div class={styles.actions}>
              <button class={styles.btn} disabled={!draftValid() || !d().name.trim()}
                data-testid="compound-save" onClick={save}>
                {isExisting() ? t('detail.labels.saveCompoundEdit') : t('detail.labels.saveCompound')}
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
