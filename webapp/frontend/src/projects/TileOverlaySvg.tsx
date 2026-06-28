/**
 * The surviving-tiles SVG overlay, shared by the inline tiling preview and the enlarged
 * tiling lightbox. viewBox is the full image size + `xMidYMid meet`, so it scales to match
 * the image it's laid over (small or enlarged). Optional onTileClick magnifies one tile.
 */
import { type Component, For } from 'solid-js';
import type { Rect } from './api';
import * as styles from './TileOverlaySvg.css';

type Props = {
  imageWidth: number;
  imageHeight: number;
  tiles: Rect[];
  class?: string;
  testid?: string;
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
  </svg>
);

export default TileOverlaySvg;
