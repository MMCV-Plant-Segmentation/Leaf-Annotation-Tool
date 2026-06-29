/**
 * Surviving-tiles SVG overlay, shared by the inline tiling preview and the enlarged
 * tiling lightbox. viewBox is the full image size + xMidYMid meet so it scales to match
 * the image it's laid over. Optional selectedTile draws a highlighted bounding box;
 * clicking the same tile again deselects. Optional onTileClick handles tile selection.
 */
import { type Component, For, Show } from 'solid-js';
import type { Rect } from './api';
import * as styles from './TileOverlaySvg.css';

type Props = {
  imageWidth: number;
  imageHeight: number;
  tiles: Rect[];
  class?: string;
  testid?: string;
  /** The currently selected tile — renders a highlighted bounding box. */
  selectedTile?: Rect | null;
  onTileClick?: (tile: Rect) => void;
};

const TileOverlaySvg: Component<Props> = (props) => (
  <svg class={props.class ?? styles.fill} data-testid={props.testid}
    viewBox={`0 0 ${props.imageWidth} ${props.imageHeight}`}
    preserveAspectRatio="xMidYMid meet">
    <For each={props.tiles}>
      {(tile: Rect) => (
        <rect x={tile.x} y={tile.y} width={tile.w} height={tile.h}
          fill="rgba(37,99,235,0.18)" stroke="#2563eb" stroke-width="2"
          vector-effect="non-scaling-stroke"
          class={props.onTileClick ? styles.clickable : undefined}
          onClick={() => props.onTileClick?.(tile)} />
      )}
    </For>
    <Show when={props.selectedTile}>
      {(t) => (
        <rect x={t().x} y={t().y} width={t().w} height={t().h}
          fill="rgba(245,158,11,0.22)" stroke="#f59e0b" stroke-width="4"
          vector-effect="non-scaling-stroke"
          style={{ 'pointer-events': 'none' }}
          data-selected="true" />
      )}
    </Show>
  </svg>
);

export default TileOverlaySvg;
