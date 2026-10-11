/**
 * t126 Phase 2: the hub's batch list — replaces the old (long-broken) "current batch
 * progress" table. Each BatchCard shows tile count / merge-ready / per-member percent;
 * `batch-open` opens a BatchMembersModal for detailed progress + add/remove editing.
 * A "create new batch" affordance sits below the list (locked until tiling is confirmed,
 * matching ProjectBatchesStep's existing gate).
 *
 * t126 Phase 2b: also hosts the "open canvas" + merge-lifecycle (enter/continue) controls
 * ported verbatim from the now-retired ProjectBatchesStep — the standalone
 * `/projects/:id/batches` page is gone, so these affordances live on the hub.
 */
import { type Component, For, Show, createSignal } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { projectsApi, type Annotator, type Batch } from './api';
import { t } from '../i18n/catalog';
import BatchCard from './BatchCard';
import BatchMembersModal from './BatchMembersModal';
import * as styles from './BatchMembership.css';

type Props = {
  projectId: string;
  batches: Batch[];
  annotators: Annotator[];
  tilingConfirmed: boolean;
  onReload: () => void;
};

const BatchMembership: Component<Props> = (props) => {
  const nav = useNavigate();
  const [openBatchId, setOpenBatchId] = createSignal<string | null>(null);
  const [batchSize, setBatchSize] = createSignal(5);
  const [busy, setBusy] = createSignal(false);
  const [mergeBusy, setMergeBusy] = createSignal<string | null>(null);

  const openBatch = () => props.batches.find((b) => b.id === openBatchId()) ?? null;

  const doCreate = async () => {
    setBusy(true);
    try {
      await projectsApi.createBatch(props.projectId, batchSize());
      props.onReload();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  // Canvas annotates as the logged-in user — no ?as= param needed.
  const openCanvas = (batchId: string) => nav(`/projects/${props.projectId}/batches/${batchId}`);
  const mergeRoute = (batchId: string) => `/projects/${props.projectId}/batches/${batchId}/merge`;

  // Merge Phase 1 gate: only mergeReady batches may enter merge (409 otherwise, but the
  // button is hidden until then anyway — see BatchCard).
  const enterMerge = async (batchId: string) => {
    setMergeBusy(batchId);
    try {
      await projectsApi.enterMerge(batchId);
      nav(mergeRoute(batchId));
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed');
    } finally {
      setMergeBusy(null);
    }
  };

  return (
    <section class={styles.panel}>
      <h3>{t('detail.batches')}</h3>
      <ul class={styles.batchList}>
        <For each={props.batches} fallback={<li class={styles.muted}>{t('detail.batch.none')}</li>}>
          {(b) => (
            <BatchCard
              batch={b}
              onOpen={setOpenBatchId}
              onOpenCanvas={openCanvas}
              onEnterMerge={(id) => void enterMerge(id)}
              onContinueMerge={(id) => nav(mergeRoute(id))}
              mergeBusy={mergeBusy() === b.id}
            />
          )}
        </For>
      </ul>

      <Show when={props.tilingConfirmed}>
        <div class={styles.createRow}>
          <label class={styles.sizeLabel}>
            {t('detail.batch.sizeLabel')}
            <input
              type="number" min="1" value={batchSize()}
              onInput={(e) => setBatchSize(Number(e.currentTarget.value))}
            />
          </label>
          <button data-testid="create-batch" disabled={busy()} onClick={() => void doCreate()}>
            {t('detail.batch.create')}
          </button>
        </div>
      </Show>

      <Show when={openBatch()}>
        {(b) => (
          <BatchMembersModal
            batch={b()}
            annotators={props.annotators}
            onClose={() => setOpenBatchId(null)}
            onReload={props.onReload}
          />
        )}
      </Show>
    </section>
  );
};

export default BatchMembership;
