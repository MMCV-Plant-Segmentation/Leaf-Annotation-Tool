/**
 * The three config-step cards on the hub. Each links to its sub-route; locked cards
 * show their reason and don't navigate (the dependency gate also guards the routes).
 */
import { type Component, Show } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { t } from '../i18n/catalog';
import * as styles from './ProjectStepCards.css';

type Props = {
  projectId: string;
  hasImages: boolean;
  tilingConfirmed: boolean;
  imageCount: number;
  batchCount: number;
};

const ProjectStepCards: Component<Props> = (props) => {
  const nav = useNavigate();
  const go = (sub: string) => nav(`/projects/${props.projectId}/${sub}`);

  const tilingLocked = () => !props.hasImages;
  const batchesLocked = () => !props.tilingConfirmed;

  return (
    <div class={styles.cards}>
      <button class={styles.card} data-testid="card-images" onClick={() => go('images')}>
        <strong>{t('detail.card.images')}</strong>
        <span class={styles.meta}>{t('projects.images', { count: props.imageCount })}</span>
      </button>

      <Show
        when={!tilingLocked()}
        fallback={
          <div class={`${styles.card} ${styles.cardLocked}`} data-testid="card-tiling-locked">
            <strong>{t('detail.card.tiling')}</strong>
            <span class={styles.lock}>{t('detail.tile.lockedNoImages')}</span>
          </div>
        }
      >
        <button class={styles.card} data-testid="card-tiling" onClick={() => go('tiling')}>
          <strong>{t('detail.card.tiling')}</strong>
          <span class={styles.meta}>{t('detail.card.tilingReady')}</span>
        </button>
      </Show>

      <Show
        when={!batchesLocked()}
        fallback={
          <div class={`${styles.card} ${styles.cardLocked}`} data-testid="card-batches-locked">
            <strong>{t('detail.card.batches')}</strong>
            <span class={styles.lock}>{t('detail.batch.lockedNoTiling')}</span>
          </div>
        }
      >
        <button class={styles.card} data-testid="card-batches" onClick={() => go('batches')}>
          <strong>{t('detail.card.batches')}</strong>
          <span class={styles.meta}>{t('projects.batches', { count: props.batchCount })}</span>
        </button>
      </Show>
    </div>
  );
};

export default ProjectStepCards;
