/**
 * One batch card in the hub's batch list: seq, tile count, merge-ready badge, its
 * durable member list (read-only here — editing happens in BatchMembersModal, opened via
 * the `batch-open` control), and — ported from the retired ProjectBatchesStep (t126 Phase 2b)
 * — the "open canvas" (member-gated) and merge-lifecycle (enter/continue) controls.
 */
import { type Component, For, Show } from 'solid-js';
import type { Batch } from './api';
import { t } from '../i18n/catalog';
import BatchMemberRow from './BatchMemberRow';
import * as styles from './BatchMembership.css';

type Props = {
  batch: Batch;
  onOpen: (batchId: string) => void;
  onOpenCanvas: (batchId: string) => void;
  onEnterMerge: (batchId: string) => void;
  onContinueMerge: (batchId: string) => void;
  mergeBusy: boolean;
};

const BatchCard: Component<Props> = (props) => (
  <li class={styles.batchCard} data-testid="batch-card" data-batch-id={props.batch.id}>
    <div class={styles.batchCardHeader}>
      <span class={styles.batchSeq}>{t('batch.card.seq', { seq: props.batch.seq })}</span>
      <span class={styles.batchTiles}>{t('batch.card.tiles', { count: props.batch.tileCount })}</span>
      <span class={props.batch.mergeReady ? styles.badgeReady : styles.badgeNotReady}>
        {props.batch.mergeReady ? t('batch.card.ready') : t('batch.card.notReady')}
      </span>
      {/* t127: a non-member sees the batch (read-only) but not "Open in canvas". */}
      <Show when={props.batch.isMember}>
        <button class={styles.link} onClick={() => props.onOpenCanvas(props.batch.id)}>
          {t('detail.batch.open')}
        </button>
      </Show>
      <Show when={props.batch.status === 'merge'}>
        <button class={styles.link} data-testid="continue-merge-btn"
          onClick={() => props.onContinueMerge(props.batch.id)}>
          {t('detail.batch.continueMerge')}
        </button>
      </Show>
      <Show when={props.batch.status !== 'merge' && props.batch.mergeReady}>
        <button class={styles.link} data-testid="enter-merge-btn" disabled={props.mergeBusy}
          onClick={() => props.onEnterMerge(props.batch.id)}>
          {t('detail.batch.enterMerge')}
        </button>
      </Show>
      <button
        class={styles.openBtn}
        data-testid="batch-open"
        onClick={() => props.onOpen(props.batch.id)}
      >{t('batch.card.manage')}</button>
    </div>
    <ul class={styles.memberList}>
      <For each={props.batch.members} fallback={<li class={styles.muted}>{t('batch.member.none')}</li>}>
        {(m) => <BatchMemberRow member={m} />}
      </For>
    </ul>
  </li>
);

export default BatchCard;
