/**
 * Batches step: locked until tiling_confirmed = true ("Configure tiling first").
 * Lists batches and lets users open the canvas as a roster member.
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
  const [openAs, setOpenAs] = createSignal('');
  const [busy, setBusy] = createSignal(false);

  const locked = () => !props.tilingConfirmed;

  const effectiveAs = () =>
    openAs() || props.annotators[0]?.byline || '';

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

  const openCanvas = (batchId: string) => {
    const as = effectiveAs();
    if (!as) { alert(t('detail.annotator.required')); return; }
    nav(`/projects/${props.projectId}/batches/${batchId}?as=${encodeURIComponent(as)}`);
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
          <Show when={props.annotators.length > 0}>
            <label class={styles.openAsLabel}>
              {t('detail.batch.openAs')}
              <select
                data-testid="open-as"
                onChange={(e) => setOpenAs(e.currentTarget.value)}
              >
                <For each={props.annotators}>
                  {(a) => <option value={a.byline}>{a.byline}</option>}
                </For>
              </select>
            </label>
          </Show>
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
