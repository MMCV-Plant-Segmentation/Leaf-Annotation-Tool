/**
 * Per-project taxonomy v2 editor (groups + saved compound labels).
 *
 * Available to ANY project member — same permission model as image upload / tiling /
 * batch management (NOT admin-only). The backend `PATCH /api/projects/:id { groups,
 * compounds }` is gated only by project membership (see webapp.projects.update_project).
 *
 * Renders inline on the Images screen. Manages GROUPS (add/rename/reorder, toggle
 * required, add/rename/reorder members) via GroupEditor, and saved COMPOUNDS (build one
 * via a one-member-per-group picker with required-group enforcement, name + colour,
 * delete) via CompoundEditor. Split into sub-components to stay under 200 lines each.
 */
import { type Component, Show, createMemo, createSignal } from 'solid-js';
import { projectsApi } from './api';
import type { Group, Compound } from './taxonomy';
import { t } from '../i18n/catalog';
import * as styles from './LabelEditor.css';
import { cloneDraft, restampOrder } from './taxonomyEditor';
import GroupEditor from './GroupEditor';
import CompoundEditor from './CompoundEditor';

type Props = {
  projectId: string;
  labels: { id: string; name: string; color: string; order: number }[];
  groups: Group[];
  compounds: Compound[];
  /** Names of compounds currently painted by some lesion (for delete-warnings). */
  usedCompoundNames?: () => Set<string>;
  onSaved: () => void;
};

export const LabelEditor: Component<Props> = (props) => {
  const [editing, setEditing] = createSignal(false);
  const [draftGroups, setDraftGroups] = createSignal<Group[]>([]);
  const [draftCompounds, setDraftCompounds] = createSignal<Compound[]>([]);
  const [saving, setSaving] = createSignal(false);
  const [err, setErr] = createSignal('');

  const open = () => {
    const c = cloneDraft(props.groups, props.compounds);
    setDraftGroups(c.groups);
    setDraftCompounds(c.compounds);
    setErr('');
    setEditing(true);
  };
  const cancel = () => { setEditing(false); setErr(''); };

  const save = async () => {
    const { groups, compounds } = restampOrder(draftGroups(), draftCompounds());
    // A project's paintable labels ARE its compounds. Refuse to save an empty set — the
    // backend would otherwise re-seed the default 'thing' compound on read, which reads
    // as the deleted label "coming back". Blocking here keeps the taxonomy non-empty by
    // construction (a fresh project still starts with the default 'thing').
    if (compounds.length === 0) {
      setErr(t('detail.labels.emptyError'));
      return;
    }
    setSaving(true); setErr('');
    try {
      await projectsApi.update(props.projectId, { groups, compounds });
      setEditing(false);
      props.onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

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
        <GroupEditor groups={draftGroups()} onChange={(g) => setDraftGroups(g)} />
        <CompoundEditor groups={draftGroups()} compounds={draftCompounds()}
          usedNames={() => props.usedCompoundNames?.() ?? new Set<string>()}
          onChange={(c) => setDraftCompounds(c)} />
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
