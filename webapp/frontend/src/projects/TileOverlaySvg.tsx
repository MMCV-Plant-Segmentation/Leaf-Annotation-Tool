/**
 * Surviving-tiles SVG overlay, shared by the inline tiling preview and the enlarged
 * tiling lightbox. viewBox is the full image size + xMidYMid meet so it scales to match
 * the image it's laid over. Outlines only (transparent fill, kept clickable as hit
 * targets). When selectedTile is set we hide the full grid and show only that tile's
 * highlight box; clicking the same tile again deselects. onTileClick handles selection.
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
    <Show when={!props.selectedTile}>
      <For each={props.tiles}>
        {(tile: Rect) => (
          <rect x={tile.x} y={tile.y} width={tile.w} height={tile.h}
            fill="transparent" stroke="#2563eb" stroke-width="2"
            vector-effect="non-scaling-stroke"
            class={props.onTileClick ? styles.gridTile : undefined}
            onClick={() => props.onTileClick?.(tile)} />
        )}
      </For>
    </Show>
    <Show when={props.selectedTile}>
      {(t) => (
        <rect x={t().x} y={t().y} width={t().w} height={t().h}
          fill="transparent" stroke="#f59e0b" stroke-width="4"
          vector-effect="non-scaling-stroke"
          class={props.onTileClick ? styles.hit : undefined}
          onClick={() => props.onTileClick?.(t())}
          data-selected="true" />
      )}
    </Show>
  </svg>
);

export default TileOverlaySvg;
