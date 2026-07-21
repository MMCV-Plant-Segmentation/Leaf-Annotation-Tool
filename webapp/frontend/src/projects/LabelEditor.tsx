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
import { type Component, Show, createEffect, createMemo, createSignal } from 'solid-js';
import { projectsApi } from './api';
import type { Group, Compound } from './taxonomy';
import { ApiError } from './httpJson';
import { t } from '../i18n/catalog';
import * as styles from './LabelEditor.css';
import { cloneDraft, restampOrder, flushPending, taxonomyKey } from './taxonomyEditor';
import GroupEditor from './GroupEditor';
import CompoundEditor from './CompoundEditor';
import ReassignPicker from './ReassignPicker';

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
  const [draftGroups, setDraftGroups] = createSignal<Group[]>([]);
  const [draftCompounds, setDraftCompounds] = createSignal<Compound[]>([]);
  // t74: the in-progress compound edit lives HERE (lifted out of CompoundEditor) so the
  // single Save can flush it and the dirty check (t76) can see it.
  const [pending, setPending] = createSignal<Compound | null>(null);
  const [saving, setSaving] = createSignal(false);
  const [err, setErr] = createSignal('');
  // t64 C4/C5/C6: set only when a save was rejected because it drops a compound that
  // existing lesions still reference — holds what's needed to render ReassignPicker and
  // retry the SAME save with `reassignCompounds` once the user picks a target.
  const [blocked, setBlocked] = createSignal<{ id: string; name: string } | null>(null);
  // t90: the editor is ALWAYS open on its own /labels route (no Edit step). Track the
  // identity of the last-seeded PERSISTED taxonomy so the draft re-seeds on the initial
  // load, after our own save's refetch, and on an external edit — but NOT on unrelated
  // re-renders (which would clobber an in-progress edit).
  const [baseKey, setBaseKey] = createSignal<string | null>(null);

  const seed = (groups: Group[], compounds: Compound[], key: string) => {
    const c = cloneDraft(groups, compounds);
    setDraftGroups(c.groups);
    setDraftCompounds(c.compounds);
    setPending(null);
    setErr(''); setBlocked(null);
    setBaseKey(key);
  };
  createEffect(() => {
    const key = taxonomyKey(props.groups, props.compounds);
    if (key !== baseKey()) seed(props.groups, props.compounds, key);
  });
  // t90: with no collapse-on-save, "Cancel" discards unsaved edits by re-seeding from the
  // persisted taxonomy (shown only while dirty).
  const revert = () => seed(props.groups, props.compounds, taxonomyKey(props.groups, props.compounds));

  // t76: enabled only when the (flushed) draft differs from what's stored — a pending
  // rename counts because flushPending folds it in before comparing.
  const dirty = createMemo(() =>
    taxonomyKey(draftGroups(), flushPending(draftCompounds(), pending(), draftGroups()))
      !== taxonomyKey(props.groups, props.compounds));

  const save = async (reassignCompounds?: Record<string, string>) => {
    // t74: flush the in-progress compound edit FIRST, then persist — one button, both jobs.
    const flushed = flushPending(draftCompounds(), pending(), draftGroups());
    const { groups, compounds } = restampOrder(draftGroups(), flushed);
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
      await projectsApi.update(props.projectId, { groups, compounds, reassignCompounds });
      // t90: stay open (no collapse). Fold the persisted values back into the draft and
      // clear the pending edit so the editor reflects the saved state immediately (no
      // stale-name flash before the parent's refetch lands) and Save re-disables (not
      // dirty). Advancing baseKey keeps the re-seed effect from redundantly re-cloning.
      seed(groups, compounds, taxonomyKey(groups, compounds));
      props.onSaved();
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { blockedCompoundId?: string } | null) : null;
      if (body?.blockedCompoundId) {
        // The blocked compound is already gone from the draft — recover its name from
        // the taxonomy this editor opened with (props.compounds), for the picker's message.
        const name = props.compounds.find((c) => c.id === body.blockedCompoundId)?.name ?? '';
        setBlocked({ id: body.blockedCompoundId, name });
      } else {
        setErr(e instanceof Error ? e.message : 'Save failed');
      }
    } finally {
      setSaving(false);
    }
  };

  const confirmReassign = (targetId: string) => {
    const b = blocked();
    if (!b) return;
    void save({ [b.id]: targetId });
  };

  const summary = createMemo(() => props.labels.map((l) => l.name).join(', ') || '—');

  return (
    <section class={styles.section} data-testid="label-editor">
      <div class={styles.head}>
        <h3 class={styles.title}>{t('detail.labels.title')}</h3>
        <span class={styles.summary} data-testid="label-summary">{summary()}</span>
      </div>

      {/* t90: always editable on the /labels route — no Edit step, no collapse on Save. */}
      <GroupEditor groups={draftGroups()} onChange={(g) => setDraftGroups(g)} />
      <CompoundEditor groups={draftGroups()} compounds={draftCompounds()}
        usedNames={() => props.usedCompoundNames?.() ?? new Set<string>()}
        pending={pending()} setPending={setPending}
        onChange={(c) => setDraftCompounds(c)} />
      <Show when={blocked()}>
        {(b) => (
          <ReassignPicker blockedName={b().name} compounds={draftCompounds()}
            onConfirm={confirmReassign} onCancel={() => setBlocked(null)} />
        )}
      </Show>
      <div class={styles.actions}>
        <button class={styles.btn} disabled={saving() || !!blocked() || !dirty()} data-testid="label-save"
          onClick={() => void save()}>
          {saving() ? t('common.saving') : t('detail.labels.save')}
        </button>
        <Show when={dirty()}>
          <button class={styles.btn} data-testid="label-cancel" onClick={revert}>{t('common.cancel')}</button>
        </Show>
        <Show when={err()}><span class={styles.err}>{err()}</span></Show>
      </div>
    </section>
  );
};

export default LabelEditor;
