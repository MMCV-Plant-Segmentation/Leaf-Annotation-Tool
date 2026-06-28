/**
 * Inline tile-preview for one image: the overview image with the surviving-tiles SVG
 * overlaid (via the shared TileOverlaySvg). Clicking enlarges it — onEnlarge hands the
 * fetched preview (dims + tiles) up so the lightbox can re-draw the same overlay.
 */
import { type Component, createResource, Show } from 'solid-js';
import { projectsApi, imageUrls, type TilePreview as TilePreviewData } from './api';
import { t } from '../i18n/catalog';
import TileOverlaySvg from './TileOverlaySvg';
import * as styles from './TilePreview.css';

type Props = {
  projectId: string;
  imageId: string;
  threshold: number;
  tileSize: number;
  onEnlarge?: (preview: TilePreviewData) => void;
};

const TilePreview: Component<Props> = (props) => {
  const [preview] = createResource(
    () => ({ img: props.imageId, th: props.threshold, ts: props.tileSize }),
    (k) => projectsApi.previewTiles(props.projectId, k.img,
      { black_threshold: k.th, tile_size: k.ts }),
  );

  return (
    <Show when={preview()} fallback={<div class={styles.muted}>{t('detail.tile.computing')}</div>}>
      <div>
        <div class={styles.box} data-testid="tile-preview-enlarge"
          onClick={() => props.onEnlarge?.(preview()!)}>
          <img src={imageUrls.overview(props.imageId)} alt="" />
          <TileOverlaySvg class={styles.svg}
            imageWidth={preview()!.imageWidth} imageHeight={preview()!.imageHeight}
            tiles={preview()!.tiles} />
        </div>
        <div class={styles.count} data-testid="survive-count">
          {t('detail.tile.surviveCount', { count: preview()!.tiles.length })}
        </div>
      </div>
    </Show>
  );
};

export default TilePreview;
