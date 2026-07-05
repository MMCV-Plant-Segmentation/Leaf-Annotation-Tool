import { type Component, For, Show } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { Tool } from './canvasShapes';
import type { Label } from './api';
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
  classOptions: () => Label[];
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

// Slider is logarithmic across [1, maxBrushSize] so the low end (fine control on
// small lesions) gets far more travel than the high end — same "multiplicative feel"
// as the scroll-wheel resize in canvasInteraction.ts's stepSize, just continuous
// instead of stepped. SLIDER_RESOLUTION is the number of discrete internal slider
// steps, independent of the actual px range.
const SLIDER_RESOLUTION = 1000;

const clampBrushSize = (v: number, max: number) => Math.max(1, Math.min(max, Math.round(v)));

const sizeToSliderPos = (size: number, max: number): number => {
  const hi = Math.log(Math.max(2, max));
  const v = clampBrushSize(size, max);
  return Math.round((Math.log(v) / hi) * SLIDER_RESOLUTION);
};

const sliderPosToSize = (pos: number, max: number): number => {
  const hi = Math.log(Math.max(2, max));
  return clampBrushSize(Math.exp((pos / SLIDER_RESOLUTION) * hi), max);
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
      <For each={(['select', 'pan', 'brush', 'eraser'] as Tool[])}>
        {(tl) => (
          <button class={props.tool() === tl ? styles.toolActive : styles.tool}
            aria-pressed={props.tool() === tl}
            onClick={() => props.setTool(tl)}
            title={tl === 'select' ? t('canvas.select') : tl === 'brush' ? 'Brush' : tl === 'eraser' ? 'Eraser (drag over strokes to delete them)' : 'Pan'}
            data-testid={`tool-${tl}`}>
            {tl === 'select' ? t('canvas.select') : tl === 'brush' ? 'brush' : tl === 'eraser' ? '✕ eraser' : 'pan'}
          </button>
        )}
      </For>
      <Show when={props.tool() === 'brush' || props.tool() === 'eraser'}>
        <label class={styles.sizeLabel}>
          {'Size'}
          <input class={styles.sizeSlider} type="range" min={0} max={SLIDER_RESOLUTION}
            step={1} value={sizeToSliderPos(props.brushSize(), props.maxBrushSize())}
            data-testid="brush-size-slider"
            onInput={(e) => props.setBrushSize(sliderPosToSize(+e.currentTarget.value, props.maxBrushSize()))} />
          <input class={styles.sizeNumberInput} type="number" min={1} max={props.maxBrushSize()}
            step={1} value={props.brushSize()} data-testid="brush-size-input"
            onChange={(e) => {
              const parsed = Number(e.currentTarget.value);
              const next = Number.isFinite(parsed) ? clampBrushSize(parsed, props.maxBrushSize()) : props.brushSize();
              e.currentTarget.value = String(next);
              props.setBrushSize(next);
            }} />
          <span data-testid="brush-size-value">{'px'}</span>
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
          <For each={props.classOptions()}>{(c) => <option value={c.name}>{c.name}</option>}</For>
          {/* Lenient backend: keep an out-of-set selClass selectable as free text. */}
          <Show when={props.selClass() && !props.classOptions().some((c) => c.name === props.selClass())}>
            <option value={props.selClass()}>{props.selClass()}</option>
          </Show>
        </select>
        <Show when={props.classOptions().find((c) => c.name === props.selClass())}>
          {(c) => <span class={styles.swatch} style={{ background: c().color }} aria-hidden="true" />}
        </Show>
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
