/**
 * One batch-member row: byline + percent-complete, with an optional remove control.
 * Rendered identically inside a BatchCard (read-only) and the BatchMembersModal
 * (removable) — see the `batch-member` / `batch-member-percent` DOM contract.
 */
import { type Component, Show } from 'solid-js';
import type { BatchMember } from './api';
import { t } from '../i18n/catalog';
import * as styles from './BatchMembership.css';

type Props = {
  member: BatchMember;
  removable?: boolean;
  onRemove?: (annotator: string) => void;
};

const BatchMemberRow: Component<Props> = (props) => (
  <li class={styles.memberRow} data-testid="batch-member" data-annotator={props.member.annotator}>
    <span class={styles.memberName}>{props.member.annotator}</span>
    <span class={styles.memberPercent} data-testid="batch-member-percent">
      {t('batch.member.percent', {
        done: props.member.tilesCompleted, total: props.member.tilesTotal, pct: props.member.percent,
      })}
    </span>
    <Show when={props.removable}>
      <button
        class={styles.linkDanger}
        data-testid="batch-remove-member"
        onClick={() => props.onRemove?.(props.member.annotator)}
      >{t('detail.annotator.remove')}</button>
    </Show>
  </li>
);

export default BatchMemberRow;
