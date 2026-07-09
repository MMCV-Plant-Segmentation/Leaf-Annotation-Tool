/**
 * Batches step: locked until tiling_confirmed = true ("Configure tiling first").
 * Lists batches and lets the logged-in user open the canvas (annotates as themselves).
 */
import { type Component, createSignal, For, Show } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { projectsApi, type Annotator, type Batch } from './api';
import { t } from '../i18n/catalog';
import * as styles from './ProjectBatchesStep.css';

type Props = {
  projectId: string;
  batches: Batch[];
  annotators: Annotator[];
  tilingConfirmed: boolean;
  onReload: () => void;
};

const ProjectBatchesStep: Component<Props> = (props) => {
  const nav = useNavigate();
  const [batchSize, setBatchSize] = createSignal(5);
  const [busy, setBusy] = createSignal(false);
  const [mergeBusy, setMergeBusy] = createSignal<string | null>(null);

  const locked = () => !props.tilingConfirmed;

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
  const openCanvas = (batchId: string) => {
    nav(`/projects/${props.projectId}/batches/${batchId}`);
  };

  const mergeRoute = (batchId: string) => `/projects/${props.projectId}/batches/${batchId}/merge`;

  // Merge Phase 1 gate: only mergeReady batches may enter merge (409 otherwise, but the
  // button is hidden until then anyway — see the batch list below).
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

      <Show when={locked()}>
        <p class={styles.lockMsg}>{t('detail.batch.lockedNoTiling')}</p>
      </Show>

      <Show when={!locked()}>
        <div class={styles.createRow}>
          <label class={styles.sizeLabel}>
            {t('detail.batch.sizeLabel')}
            <input type="number" min="1" value={batchSize()}
              onInput={(e) => setBatchSize(Number(e.currentTarget.value))} />
          </label>
          <button disabled={busy()} onClick={() => void doCreate()}>
            {t('detail.batch.create')}
          </button>
        </div>

        <ul class={styles.batchList}>
          <For each={props.batches}
            fallback={<li class={styles.muted}>{t('detail.batch.none')}</li>}
          >
            {(b) => (
              <li class={styles.batchItem}>
                <span>{t('detail.batch.info', { seq: b.seq, count: b.tileCount, status: b.status })}</span>
                <button class={styles.link} onClick={() => openCanvas(b.id)}>
                  {t('detail.batch.open')}
                </button>
                <Show when={b.status === 'merge'}>
                  <button class={styles.link} data-testid="continue-merge-btn"
                    onClick={() => nav(mergeRoute(b.id))}>
                    {t('detail.batch.continueMerge')}
                  </button>
                </Show>
                <Show when={b.status !== 'merge' && b.mergeReady}>
                  <button class={styles.link} data-testid="enter-merge-btn" disabled={mergeBusy() === b.id}
                    onClick={() => void enterMerge(b.id)}>
                    {t('detail.batch.enterMerge')}
                  </button>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
};

export default ProjectBatchesStep;
