/**
 * Batch member editor popup: detailed per-member progress + add/remove. Add picks a
 * project-roster annotator not already a member; remove shows a confirm step when the
 * server 409s {needsConfirm:true} (the member has existing work — their annotations and
 * completion rows are preserved on a confirmed remove).
 */
import { type Component, For, Show, createMemo, createSignal } from 'solid-js';
import {
  Root as DialogRoot, Portal as DialogPortal, Overlay as DialogOverlay,
  Content as DialogContent, CloseButton as DialogClose,
} from '@kobalte/core/dialog';
import { projectsApi, type Annotator, type Batch } from './api';
import { ApiError } from './httpJson';
import { t } from '../i18n/catalog';
import BatchMemberRow from './BatchMemberRow';
import * as styles from './BatchMembersModal.css';

type Props = {
  batch: Batch;
  annotators: Annotator[];
  onClose: () => void;
  onReload: () => void;
};

const BatchMembersModal: Component<Props> = (props) => {
  const [selected, setSelected] = createSignal('');
  const [pendingRemove, setPendingRemove] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [err, setErr] = createSignal('');

  const availableToAdd = createMemo(() => {
    const members = new Set(props.batch.members.map((m) => m.annotator));
    return props.annotators.filter((a) => !members.has(a.byline));
  });

  const doAdd = async () => {
    const byline = selected();
    if (!byline) return;
    setBusy(true);
    setErr('');
    try {
      await projectsApi.addBatchMember(props.batch.id, byline);
      setSelected('');
      props.onReload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const attemptRemove = async (annotator: string, confirm: boolean) => {
    setBusy(true);
    setErr('');
    try {
      await projectsApi.removeBatchMember(props.batch.id, annotator, confirm);
      setPendingRemove(null);
      props.onReload();
    } catch (e) {
      const needsConfirm = e instanceof ApiError
        && (e.body as { needsConfirm?: boolean } | null)?.needsConfirm === true;
      if (needsConfirm) {
        setPendingRemove(annotator);
      } else {
        setErr(e instanceof Error ? e.message : 'Failed');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogRoot open onOpenChange={(o) => { if (!o) props.onClose(); }} modal>
      <DialogPortal>
        <DialogOverlay class={styles.overlay} />
        <div class={styles.positioner}>
          <DialogContent class={styles.modalContent} data-testid="batch-members-modal">
            <DialogClose class={styles.closeBtn} aria-label={t('common.cancel')}>×</DialogClose>
            <h3>{t('batch.modal.title', { seq: props.batch.seq })}</h3>
            <ul class={styles.memberList}>
              <For each={props.batch.members} fallback={<li class={styles.muted}>{t('batch.member.none')}</li>}>
                {(m) => (
                  <BatchMemberRow member={m} removable onRemove={(a) => void attemptRemove(a, false)} />
                )}
              </For>
            </ul>
            <Show when={pendingRemove()}>
              {(annotator) => (
                <div class={styles.confirmBox} data-testid="batch-remove-confirm">
                  <span>{t('batch.remove.confirm', { annotator: annotator() })}</span>
                  <button
                    data-testid="batch-remove-confirm-yes"
                    disabled={busy()}
                    onClick={() => void attemptRemove(annotator(), true)}
                  >{t('batch.remove.confirmYes')}</button>
                  <button onClick={() => setPendingRemove(null)}>{t('common.cancel')}</button>
                </div>
              )}
            </Show>
            <div class={styles.addRow}>
              <select
                data-testid="batch-add-select"
                value={selected()}
                onChange={(e) => setSelected(e.currentTarget.value)}
              >
                <option value="">{t('batch.add.placeholder')}</option>
                <For each={availableToAdd()}>
                  {(a) => <option value={a.byline}>{a.byline}</option>}
                </For>
              </select>
              <button
                data-testid="batch-add-member"
                disabled={!selected() || busy()}
                onClick={() => void doAdd()}
              >{t('batch.add.button')}</button>
            </div>
            <Show when={err()}>
              <div class={styles.err}>{err()}</div>
            </Show>
          </DialogContent>
        </div>
      </DialogPortal>
    </DialogRoot>
  );
};

export default BatchMembersModal;
