/**
 * Per-project label taxonomy editor (Option A: flat list, no hierarchy/sharing).
 *
 * Available to ANY project member — same permission model as image upload / tiling /
 * batch management (NOT admin-only). The backend `PATCH /api/projects/:id { classes }`
 * is gated only by project membership (see webapp.projects.update_project).
 *
 * Renders inline on the Images screen (where upload/tiling/batch config already live).
 * Add / rename / recolour / reorder / remove labels. "unknown" is removable like any
 * other (no forced/undeletable label). Kept under 200 lines.
 */
import { type Component, For, Show, createMemo, createSignal } from 'solid-js';
import { projectsApi, type Label } from './api';
import { t } from '../i18n/catalog';
import * as styles from './LabelEditor.css';

const PALETTE = [
  '#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed',
  '#0891b2', '#db2777', '#65a30d', '#ea580c', '#0f766e',
];

const uid = (): string =>
  (globalThis.crypto?.randomUUID?.() ??
    `id-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`);

const nextColor = (labels: Label[]): string =>
  PALETTE[labels.length % PALETTE.length];

type Props = {
  projectId: string;
  labels: Label[];
  /** Bump after a successful save so the parent refetches the canonical row. */
  onSaved: () => void;
};

export const LabelEditor: Component<Props> = (props) => {
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal<Label[]>([]);
  const [saving, setSaving] = createSignal(false);
  const [err, setErr] = createSignal('');

  const open = () => {
    // Deep clone so Cancel discards changes without mutating the live project row.
    setDraft(props.labels.map((l, i) => ({ ...l, order: i })));
    setErr('');
    setEditing(true);
  };

  const cancel = () => { setEditing(false); setErr(''); };

  const save = async () => {
    const labels = draft();
    // Drop empty-name rows; re-stamp order. Allow the list to become empty (the
    // backend re-seeds 'unknown' on read, so the project is never truly label-less).
    const cleaned = labels
      .map((l, i) => ({ ...l, name: l.name.trim(), order: i }))
      .filter((l) => l.name);
    setSaving(true); setErr('');
    try {
      await projectsApi.update(props.projectId, { classes: cleaned });
      setEditing(false);
      props.onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const add = () =>
    setDraft((d) => [...d, { id: uid(), name: '', color: nextColor(d), order: d.length }]);
  const remove = (id: string) => setDraft((d) => d.filter((l) => l.id !== id));
  const setName = (id: string, name: string) =>
    setDraft((d) => d.map((l) => (l.id === id ? { ...l, name } : l)));
  const setColor = (id: string, color: string) =>
    setDraft((d) => d.map((l) => (l.id === id ? { ...l, color } : l)));
  const move = (id: string, dir: -1 | 1) =>
    setDraft((d) => {
      const i = d.findIndex((l) => l.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= d.length) return d;
      const next = d.slice();
      [next[i], next[j]] = [next[j], next[i]];
      return next.map((l, k) => ({ ...l, order: k }));
    });

  const summary = createMemo(() => props.labels.map((l) => l.name).join(', ') || '—');

  return (
    <section class={styles.section} data-testid="label-editor">
      <div class={styles.head}>
        <h3 class={styles.title}>{t('detail.labels.title')}</h3>
        <span class={styles.summary} data-testid="label-summary">{summary()}</span>
        <Show when={!editing()}>
          <button class={styles.btn} data-testid="label-edit" onClick={open}>
            {t('detail.labels.edit')}
          </button>
        </Show>
      </div>

      <Show when={editing()}>
        <div class={styles.list}>
          <For each={draft()}>
            {(l) => (
              <div class={styles.row} data-testid="label-row">
                <input class={styles.color} type="color" value={l.color}
                  data-testid="label-color"
                  onInput={(e) => setColor(l.id, e.currentTarget.value)} />
                <input class={styles.name} type="text" value={l.name}
                  placeholder={t('detail.labels.namePlaceholder')}
                  data-testid="label-name"
                  onInput={(e) => setName(l.id, e.currentTarget.value)} />
                <button class={styles.iconBtn} title={t('detail.labels.up')}
                  disabled={draft().findIndex((x) => x.id === l.id) === 0}
                  onClick={() => move(l.id, -1)}>↑</button>
                <button class={styles.iconBtn} title={t('detail.labels.down')}
                  disabled={draft().findIndex((x) => x.id === l.id) === draft().length - 1}
                  onClick={() => move(l.id, 1)}>↓</button>
                <button class={styles.iconBtn} classList={{ [styles.danger]: true }}
                  title={t('detail.labels.remove')} data-testid="label-remove"
                  onClick={() => remove(l.id)}>✕</button>
              </div>
            )}
          </For>
          <button class={styles.addBtn} data-testid="label-add" onClick={add}>
            {t('detail.labels.add')}
          </button>
        </div>
        <div class={styles.actions}>
          <button class={styles.btn} disabled={saving()} data-testid="label-save"
            onClick={() => void save()}>
            {saving() ? t('common.saving') : t('detail.labels.save')}
          </button>
          <button class={styles.btn} onClick={cancel}>{t('common.cancel')}</button>
          <Show when={err()}><span class={styles.err}>{err()}</span></Show>
        </div>
      </Show>
    </section>
  );
};

export default LabelEditor;
