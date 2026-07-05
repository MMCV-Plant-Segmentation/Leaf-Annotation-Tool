/**
 * Group editor for taxonomy v2: add/rename/reorder groups, toggle required, and
 * add/rename/reorder members within a group. Members carry name + order only (NO colour).
 *
 * Extracted from LabelEditor to keep each FE file under 200 lines. Pure presentation over
 * a draft `{groups, compounds}` signal owned by the parent; mutates via callbacks.
 */
import { type Component, For } from 'solid-js';
import type { Group } from './taxonomy';
import { t } from '../i18n/catalog';
import * as styles from './LabelEditor.css';
import { uid } from './taxonomyEditor';

type Props = {
  groups: Group[];
  onChange: (groups: Group[]) => void;
};

const move = <T,>(arr: T[], i: number, dir: -1 | 1): T[] => {
  const j = i + dir;
  if (i < 0 || j < 0 || j >= arr.length) return arr;
  const next = arr.slice();
  [next[i], next[j]] = [next[j], next[i]];
  return next;
};
const restamp = <T extends { order: number }>(arr: T[]): T[] =>
  arr.map((x, i) => ({ ...x, order: i }));

export const GroupEditor: Component<Props> = (props) => {
  const setGroups = (fn: (gs: Group[]) => Group[]) => props.onChange(fn(props.groups));

  const addGroup = () => setGroups((gs) => restamp([...gs, {
    id: uid(), name: '', order: gs.length, required: false, members: [],
  }]));
  const renameGroup = (id: string, name: string) =>
    setGroups((gs) => gs.map((g) => (g.id === id ? { ...g, name } : g)));
  const toggleRequired = (id: string) =>
    setGroups((gs) => gs.map((g) => (g.id === id ? { ...g, required: !g.required } : g)));
  const removeGroup = (id: string) => {
    // EDGE POLICY: warn that lesions using compounds built on this group keep their
    // denormalised snapshot (colour/selections never vanish). The BE filters the affected
    // compounds on save; existing lesions are untouched.
    if (!window.confirm(t('detail.labels.deleteGroupConfirm'))) return;
    setGroups((gs) => restamp(gs.filter((g) => g.id !== id)));
  };
  const moveGroup = (id: string, dir: -1 | 1) =>
    setGroups((gs) => restamp(move(gs, gs.findIndex((g) => g.id === id), dir)));

  const addMember = (gid: string) =>
    setGroups((gs) => gs.map((g) => (g.id === gid
      ? { ...g, members: restamp([...g.members, { id: uid(), name: '', order: g.members.length }]) }
      : g)));
  const renameMember = (gid: string, mid: string, name: string) =>
    setGroups((gs) => gs.map((g) => (g.id === gid
      ? { ...g, members: g.members.map((m) => (m.id === mid ? { ...m, name } : m)) }
      : g)));
  const removeMember = (gid: string, mid: string) => {
    if (!window.confirm(t('detail.labels.deleteMemberConfirm'))) return;
    setGroups((gs) => gs.map((g) => (g.id === gid
      ? { ...g, members: restamp(g.members.filter((m) => m.id !== mid)) }
      : g)));
  };
  const moveMember = (gid: string, mid: string, dir: -1 | 1) =>
    setGroups((gs) => gs.map((g) => {
      if (g.id !== gid) return g;
      return { ...g, members: restamp(move(g.members, g.members.findIndex((m) => m.id === mid), dir)) };
    }));

  return (
    <div class={styles.list}>
      <h4 class={styles.subTitle}>{t('detail.labels.groupsTitle')}</h4>
      <For each={props.groups}>
        {(g, gi) => (
          <div class={styles.groupBlock} data-testid="group-row">
            <div class={styles.row}>
              <input class={styles.name} type="text" value={g.name}
                placeholder={t('detail.labels.groupNamePlaceholder')}
                data-testid="group-name"
                onInput={(e) => renameGroup(g.id, e.currentTarget.value)} />
              <label class={styles.checkLabel}>
                <input type="checkbox" checked={g.required}
                  data-testid="group-required"
                  onChange={() => toggleRequired(g.id)} />
                {t('detail.labels.required')}
              </label>
              <button class={styles.iconBtn} title={t('detail.labels.up')}
                disabled={gi() === 0} onClick={() => moveGroup(g.id, -1)}>↑</button>
              <button class={styles.iconBtn} title={t('detail.labels.down')}
                disabled={gi() === props.groups.length - 1} onClick={() => moveGroup(g.id, 1)}>↓</button>
              <button class={styles.iconBtn} classList={{ [styles.danger]: true }}
                title={t('detail.labels.remove')} data-testid="group-remove"
                onClick={() => removeGroup(g.id)}>✕</button>
            </div>
            <For each={g.members}>
              {(m, mi) => (
                <div class={styles.memberRow} data-testid="member-row">
                  <span class={styles.memberBullet}>·</span>
                  <input class={styles.name} type="text" value={m.name}
                    placeholder={t('detail.labels.memberNamePlaceholder')}
                    data-testid="member-name"
                    onInput={(e) => renameMember(g.id, m.id, e.currentTarget.value)} />
                  <button class={styles.iconBtn} title={t('detail.labels.up')}
                    disabled={mi() === 0} onClick={() => moveMember(g.id, m.id, -1)}>↑</button>
                  <button class={styles.iconBtn} title={t('detail.labels.down')}
                    disabled={mi() === g.members.length - 1} onClick={() => moveMember(g.id, m.id, 1)}>↓</button>
                  <button class={styles.iconBtn} classList={{ [styles.danger]: true }}
                    title={t('detail.labels.remove')} data-testid="member-remove"
                    onClick={() => removeMember(g.id, m.id)}>✕</button>
                </div>
              )}
            </For>
            <button class={styles.addBtn} data-testid="member-add"
              onClick={() => addMember(g.id)}>
              {t('detail.labels.addMember')}
            </button>
          </div>
        )}
      </For>
      <button class={styles.addBtn} data-testid="group-add" onClick={addGroup}>
        {t('detail.labels.addGroup')}
      </button>
    </div>
  );
};

export default GroupEditor;
