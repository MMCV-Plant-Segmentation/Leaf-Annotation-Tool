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
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
};

export default ProjectBatchesStep;
