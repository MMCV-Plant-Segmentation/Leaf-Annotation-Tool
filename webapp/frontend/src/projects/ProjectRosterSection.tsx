/**
 * Roster section: add registered users to a project via autocomplete.
 * Add-annotator autocompletes over /api/users/members; Add button enables
 * only when a valid registered user is selected.
 */
import {
  type Component, createSignal, createResource, For, Show, onCleanup,
} from 'solid-js';
import { projectsApi, type Annotator, type RosterUser } from './api';
import { t } from '../i18n/catalog';
import * as styles from './ProjectRosterSection.css';

type Props = {
  projectId: string;
  annotators: Annotator[];
  onReload: () => void;
};

const ProjectRosterSection: Component<Props> = (props) => {
  const [query, setQuery] = createSignal('');
  const [selected, setSelected] = createSignal<RosterUser | null>(null);
  const [open, setOpen] = createSignal(false);
  const [addErr, setAddErr] = createSignal('');

  // Debounced autocomplete fetch
  const [suggestions] = createResource(
    () => query().trim() || null,
    (q) => projectsApi.listUsers(q),
  );

  const pick = (u: RosterUser) => {
    setSelected(u);
    setQuery(u.username);
    setOpen(false);
  };

  const handleInput = (v: string) => {
    setQuery(v);
    setSelected(null);   // clear selection when typing
    setOpen(v.length > 0);
  };

  // Close dropdown on outside click
  let wrapRef: HTMLDivElement | undefined;
  const onDocClick = (e: MouseEvent) => {
    if (wrapRef && !wrapRef.contains(e.target as Node)) setOpen(false);
  };
  document.addEventListener('click', onDocClick);
  onCleanup(() => document.removeEventListener('click', onDocClick));

  const doAdd = async () => {
    const u = selected();
    if (!u) return;
    setAddErr('');
    try {
      await projectsApi.addAnnotator(props.projectId, u.id);
      setQuery('');
      setSelected(null);
      props.onReload();
    } catch (e) {
      setAddErr(e instanceof Error ? e.message : 'Failed');
    }
  };

  const doRemove = async (annotatorId: string) => {
    try {
      await projectsApi.removeAnnotator(props.projectId, annotatorId);
      props.onReload();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    }
  };

  return (
    <section class={styles.panel}>
      <h3>{t('detail.annotators')}</h3>
      <div class={styles.autocompleteWrap} ref={wrapRef}>
        <div class={styles.addRow}>
          <input
            type="text"
            placeholder={t('detail.annotator.searchPlaceholder')}
            value={query()}
            onInput={(e) => handleInput(e.currentTarget.value)}
            onFocus={() => { if (query()) setOpen(true); }}
            aria-autocomplete="list"
            data-testid="roster-search"
          />
          <button
            onClick={() => void doAdd()}
            disabled={!selected()}
          >{t('detail.annotator.add')}</button>
        </div>
        <Show when={open() && suggestions() && suggestions()!.length > 0}>
          <ul class={styles.dropdown} role="listbox">
            <For each={suggestions()!}>
              {(u) => (
                <li
                  class={styles.dropdownItem}
                  role="option"
                  data-testid="roster-option"
                  onClick={() => pick(u)}
                >
                  {u.username}
                </li>
              )}
            </For>
          </ul>
        </Show>
        <Show when={addErr()}>
          <div class={styles.err}>{addErr()}</div>
        </Show>
      </div>
      <ul class={styles.rosterList}>
        <For each={props.annotators}
          fallback={<li class={styles.muted}>{t('detail.annotator.none')}</li>}
        >
          {(a) => (
            <li class={styles.rosterItem}>
              <span>{a.byline}</span>
              <button class={styles.linkDanger} onClick={() => void doRemove(a.id)}>
                {t('detail.annotator.remove')}
              </button>
            </li>
          )}
        </For>
      </ul>
    </section>
  );
};

export default ProjectRosterSection;
