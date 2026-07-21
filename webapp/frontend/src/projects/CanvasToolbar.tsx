import { type Component, type JSX, For, Show } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { Tool } from './canvasShapes';
import type { Label } from './api';
import { AnnotatorPicker } from './AnnotatorPicker';
import { LabelPicker } from './LabelPicker';
import { toolMeta } from './canvasToolRegistry';
import { t } from '../i18n/catalog';
import * as styles from './CanvasScreen.css';

type Props = {
  /** Enabled tool buttons, in order — TOOLS-LIST-DRIVEN (see canvasToolRegistry.ts).
   * Annotate: ['select','pan','brush','eraser']. Merge: ['pan'] only (Phase 1 — no
   * grouping/erase/select-CO tools yet). */
  tools: Tool[];
  tool: Accessor<Tool>;
  setTool: (tl: Tool) => void;
  /** Outer wrapper `data-testid` — defaults to the annotate value; merge overrides. */
  wrapTestId?: string;
  /** Leading badge slot, rendered right after Back — e.g. merge's blind-mode pill. */
  badge?: JSX.Element;
  /** Undefined ⇒ no annotator info is rendered at all (merge has no annotator concept). */
  annotator?: string;
  // BUGS #15: admin is a read-only viewer of another annotator's work — when true, the
  // whole paint/erase/undo/redo/class-picker cluster below is hidden, and the annotator
  // slot renders a roster picker instead of a plain "as X" label. Annotate-only; merge
  // never sets this (it has no per-annotator concept to switch between).
  readOnly?: boolean;
  roster?: Accessor<string[]>;
  onSelectAnnotator?: (byline: string) => void;
  brushSize?: Accessor<number>;
  setBrushSize?: (s: number) => void;
  maxBrushSize?: Accessor<number>;
  // t65: on the Select tool, the size control targets the SELECTED mask (null = no selection).
  selectionSize?: () => number | null;
  setSelectionSize?: (px: number) => void;
  selClass?: Accessor<string>;
  setSelClass?: (c: string) => void;
  classOptions?: () => Label[];
  imgIdx: Accessor<number>;
  imgCount: number;
  onBack: () => void;
  onFit: () => void;
  onImgPrev: () => void;
  onImgNext: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: Accessor<boolean>;
  canRedo?: Accessor<boolean>;
};

// Slider is logarithmic across [1, maxBrushSize] so the low end (fine control on
// small lesions) gets far more travel than the high end — same "multiplicative feel"
// as the scroll-wheel resize in canvasInteraction.ts's stepSize, just continuous
// instead of stepped. SLIDER_RESOLUTION is the number of discrete internal slider
// steps, independent of the actual px range.
const SLIDER_RESOLUTION = 1000;

const clampBrushSize = (v: number, max: number) => Math.max(1, Math.min(max, Math.round(v)));

// Quick absolute sizes for the Select-tool presets dropdown (t65). Clamped to maxBrushSize on pick.
const SIZE_PRESETS = [2, 4, 8, 16, 32, 64];

// The active size control target: the brush (paint tools) or the SELECTED mask (Select tool,
// t65) — or null when no size control applies. `presets` gates the dropdown (selection only).
type SizeCtx = { get: () => number; set: (n: number) => void; presets: boolean };
const activeSizeCtx = (props: Props): SizeCtx | null => {
  const tl = props.tool();
  if ((tl === 'brush' || tl === 'eraser' || tl === 'polyline') && props.brushSize && props.setBrushSize)
    return { get: props.brushSize, set: props.setBrushSize, presets: false };
  if (tl === 'select' && props.selectionSize && props.setSelectionSize && props.selectionSize() != null)
    return { get: () => props.selectionSize!() ?? 1, set: props.setSelectionSize, presets: true };
  return null;
};

const sizeToSliderPos = (size: number, max: number): number => {
  const hi = Math.log(Math.max(2, max));
  const v = clampBrushSize(size, max);
  return Math.round((Math.log(v) / hi) * SLIDER_RESOLUTION);
};

const sliderPosToSize = (pos: number, max: number): number => {
  const hi = Math.log(Math.max(2, max));
  return clampBrushSize(Math.exp((pos / SLIDER_RESOLUTION) * hi), max);
};

// Toolbar strip shared by CanvasScreen (annotate) and MergeCanvasScreen (merge) — a
// `tools: Tool[]` list drives which tool buttons render (see canvasToolRegistry.ts);
// every annotate-only extra (brush size, undo/redo, class picker, annotator info) is
// conditional on its own props/callbacks being supplied, so merge simply omits them.
export const CanvasToolbar: Component<Props> = (props) => (
  <div class={styles.toolbar} data-testid={props.wrapTestId ?? 'canvas-toolbar'}>
    <button class={styles.back} onClick={props.onBack}>{t('canvas.back')}</button>
    {props.badge}
    <Show when={props.annotator !== undefined}>
      <Show when={!props.readOnly} fallback={
        <AnnotatorPicker roster={props.roster!} value={() => props.annotator!} onChange={props.onSelectAnnotator!} />
      }>
        <span class={styles.who}>{t('canvas.as')} <strong>{props.annotator}</strong></span>
      </Show>
    </Show>
    <span class={styles.sep} />
    <Show when={!props.readOnly}>
      <For each={props.tools}>
        {(tl) => {
          const m = toolMeta(tl);
          return (
            <button class={props.tool() === tl ? styles.toolActive : styles.tool}
              aria-pressed={props.tool() === tl}
              onClick={() => props.setTool(tl)}
              title={m.title}
              data-testid={m.testId}>
              {m.label}
            </button>
          );
        }}
      </For>
      {/* Size control — brush size on the paint tools, or the SELECTED mask's width on the
          Select tool (t65, with a quick-presets dropdown). See activeSizeCtx. */}
      <Show when={props.maxBrushSize && props.tools.includes(props.tool()) && activeSizeCtx(props)}>
        {(ctx) => (
          <label class={styles.sizeLabel}>
            {'Size'}
            <input class={styles.sizeSlider} type="range" min={0} max={SLIDER_RESOLUTION}
              step={1} value={sizeToSliderPos(ctx().get(), props.maxBrushSize!())}
              data-testid="brush-size-slider"
              onInput={(e) => ctx().set(sliderPosToSize(+e.currentTarget.value, props.maxBrushSize!()))} />
            <input class={styles.sizeNumberInput} type="number" min={1} max={props.maxBrushSize!()}
              step={1} value={ctx().get()} data-testid="brush-size-input"
              onChange={(e) => {
                const parsed = Number(e.currentTarget.value);
                const next = Number.isFinite(parsed) ? clampBrushSize(parsed, props.maxBrushSize!()) : ctx().get();
                e.currentTarget.value = String(next);
                ctx().set(next);
              }} />
            <span data-testid="brush-size-value">{'px'}</span>
            <Show when={ctx().presets}>
              <select class={styles.sizeNumberInput} data-testid="size-presets"
                onChange={(e) => {
                  const v = Number(e.currentTarget.value);
                  e.currentTarget.value = '';
                  if (v) ctx().set(clampBrushSize(v, props.maxBrushSize!()));
                }}>
                <option value="">{t('canvas.sizePresets')}</option>
                <For each={SIZE_PRESETS}>{(px) => <option value={px}>{px + ' px'}</option>}</For>
              </select>
            </Show>
          </label>
        )}
      </Show>
      <Show when={props.onUndo && props.onRedo}>
        <span class={styles.sep} />
        <button class={styles.tool} disabled={!props.canUndo?.()} onClick={props.onUndo}
          data-testid="undo-btn" title="Undo (Ctrl+Z)">{t('canvas.undo')}</button>
        <button class={styles.tool} disabled={!props.canRedo?.()} onClick={props.onRedo}
          data-testid="redo-btn" title="Redo (Ctrl+Shift+Z / Ctrl+Y)">{t('canvas.redo')}</button>
      </Show>
      <Show when={props.selClass && props.setSelClass && props.classOptions}>
        <span class={styles.sep} />
        <span class={styles.classPick}>{t('canvas.class')}
          <LabelPicker value={props.selClass!} onChange={props.setSelClass!}
            options={props.classOptions!} ariaLabel={t('canvas.class')} testId="class-picker" />
        </span>
      </Show>
    </Show>
    <button class={styles.tool} onClick={props.onFit}>{t('canvas.fit')}</button>
    <Show when={props.imgCount > 1}>
      <span class={styles.sep} />
      <button class={styles.tool} disabled={props.imgIdx() === 0}
        data-testid="img-prev" onClick={props.onImgPrev}>{t('canvas.imgPrev')}</button>
      <span class={styles.who}>{props.imgIdx() + 1}/{props.imgCount}</span>
      <button class={styles.tool} disabled={props.imgIdx() >= props.imgCount - 1}
        data-testid="img-next" onClick={props.onImgNext}>{t('canvas.imgNext')}</button>
    </Show>
  </div>
);
