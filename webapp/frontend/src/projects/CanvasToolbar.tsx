import { type Component, For, Show } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { Tool } from './canvasShapes';
import { AnnotatorPicker } from './AnnotatorPicker';
import { t } from '../i18n/catalog';
import * as styles from './CanvasScreen.css';

type Props = {
  tool: Accessor<Tool>;
  setTool: (tl: Tool) => void;
  annotator: string;
  readOnly: boolean;
  roster: Accessor<string[]>;
  onSelectAnnotator: (byline: string) => void;
  brushSize: Accessor<number>;
  setBrushSize: (s: number) => void;
  maxBrushSize: Accessor<number>;
  selClass: Accessor<string>;
  setSelClass: (c: string) => void;
  classOptions: () => string[];
  imgIdx: Accessor<number>;
  imgCount: number;
  onBack: () => void;
  onFit: () => void;
  onImgPrev: () => void;
  onImgNext: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: Accessor<boolean>;
  canRedo: Accessor<boolean>;
};

// Toolbar strip extracted from CanvasScreen to keep parent under 200 lines.
export const CanvasToolbar: Component<Props> = (props) => (
  <div class={styles.toolbar} data-testid="canvas-toolbar">
    <button class={styles.back} onClick={props.onBack}>{t('canvas.back')}</button>
    <Show when={!props.readOnly} fallback={
      <AnnotatorPicker roster={props.roster} value={() => props.annotator} onChange={props.onSelectAnnotator} />
    }>
      <span class={styles.who}>{t('canvas.as')} <strong>{props.annotator}</strong></span>
    </Show>
    <span class={styles.sep} />
    {/* BUGS #15: admin is a read-only viewer — no paint/erase/undo/redo/class tools. */}
    <Show when={!props.readOnly}>
      <For each={(['pan', 'brush', 'eraser'] as Tool[])}>
        {(tl) => (
          <button class={props.tool() === tl ? styles.toolActive : styles.tool}
            onClick={() => props.setTool(tl)}
            title={tl === 'brush' ? 'Brush' : tl === 'eraser' ? 'Eraser (drag over strokes to delete them)' : 'Pan'}>
            {tl === 'brush' ? 'brush' : tl === 'eraser' ? '✕ eraser' : 'pan'}
          </button>
        )}
      </For>
      <Show when={props.tool() === 'brush' || props.tool() === 'eraser'}>
        <label class={styles.sizeLabel}>
          {'Size'}
          <input class={styles.sizeSlider} type="range" min={1} max={props.maxBrushSize()}
            step={1} value={props.brushSize()} data-testid="brush-size-slider"
            onInput={(e) => props.setBrushSize(+e.currentTarget.value)} />
          <span data-testid="brush-size-value">{`${props.brushSize()}px`}</span>
        </label>
      </Show>
      <span class={styles.sep} />
      <button class={styles.tool} disabled={!props.canUndo()} onClick={props.onUndo}
        data-testid="undo-btn" title="Undo (Ctrl+Z)">{t('canvas.undo')}</button>
      <button class={styles.tool} disabled={!props.canRedo()} onClick={props.onRedo}
        data-testid="redo-btn" title="Redo (Ctrl+Shift+Z / Ctrl+Y)">{t('canvas.redo')}</button>
      <span class={styles.sep} />
      <label class={styles.classPick}>{t('canvas.class')}
        <select onChange={(e) => props.setSelClass(e.currentTarget.value)} value={props.selClass()}>
          <For each={props.classOptions()}>{(c) => <option value={c}>{c}</option>}</For>
        </select>
      </label>
    </Show>
    <button class={styles.tool} onClick={props.onFit}>{t('canvas.fit')}</button>
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
