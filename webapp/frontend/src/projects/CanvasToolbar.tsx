import { type Component, For, Show } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { Tool } from './canvasShapes';
import { t } from '../i18n/catalog';
import * as styles from './CanvasScreen.css';

type Props = {
  tool: Accessor<Tool>;
  setTool: (tl: Tool) => void;
  annotator: string;
  brushSize: Accessor<number>;
  setBrushSize: (s: number) => void;
  maxBrushSize: Accessor<number>;
  selClass: Accessor<string>;
  setSelClass: (c: string) => void;
  classOptions: () => string[];
  selAnn: Accessor<string | null>;
  imgIdx: Accessor<number>;
  imgCount: number;
  onBack: () => void;
  onFit: () => void;
  onDelete: () => void;
  onImgPrev: () => void;
  onImgNext: () => void;
};

// Toolbar strip extracted from CanvasScreen to keep parent under 200 lines.
export const CanvasToolbar: Component<Props> = (props) => (
  <div class={styles.toolbar} data-testid="canvas-toolbar">
    <button class={styles.back} onClick={props.onBack}>{t('canvas.back')}</button>
    <span class={styles.who}>{t('canvas.as')} <strong>{props.annotator}</strong></span>
    <span class={styles.sep} />
    <For each={(['pan', 'brush'] as Tool[])}>
      {(tl) => (
        <button class={props.tool() === tl ? styles.toolActive : styles.tool}
          onClick={() => props.setTool(tl)}
          title={tl === 'pan' ? 'Pan (H)' : 'Brush (B)'}>
          {tl === 'brush' ? 'B brush' : 'H pan'}
        </button>
      )}
    </For>
    <Show when={props.tool() === 'brush'}>
      <label class={styles.sizeLabel}>
        {'Size'}
        <input class={styles.sizeSlider} type="range" min={1} max={props.maxBrushSize()}
          step={1} value={props.brushSize()} data-testid="brush-size-slider"
          onInput={(e) => props.setBrushSize(+e.currentTarget.value)} />
        <span data-testid="brush-size-value">{`${props.brushSize()}px`}</span>
      </label>
    </Show>
    <span class={styles.sep} />
    <label class={styles.classPick}>{t('canvas.class')}
      <select onChange={(e) => props.setSelClass(e.currentTarget.value)} value={props.selClass()}>
        <For each={props.classOptions()}>{(c) => <option value={c}>{c}</option>}</For>
      </select>
    </label>
    <button class={styles.tool} onClick={props.onFit}>{t('canvas.fit')}</button>
    <Show when={props.selAnn()}>
      <button class={styles.danger} onClick={props.onDelete}>{t('canvas.deleteShape')}</button>
    </Show>
    <Show when={props.imgCount > 1}>
      <span class={styles.sep} />
      <button class={styles.tool} disabled={props.imgIdx() === 0}
        onClick={props.onImgPrev}>{t('canvas.imgPrev')}</button>
      <span class={styles.who}>{props.imgIdx() + 1}/{props.imgCount}</span>
      <button class={styles.tool} disabled={props.imgIdx() >= props.imgCount - 1}
        onClick={props.onImgNext}>{t('canvas.imgNext')}</button>
    </Show>
  </div>
);
