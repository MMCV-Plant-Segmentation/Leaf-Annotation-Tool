import { type Component, type JSX, For, Show } from 'solid-js';
import type { Accessor } from 'solid-js';
import { imageUrls, type CanvasImage, type CanvasTile, type CanvasAnnotation } from './api';
import { type Tool, type ViewBox, AnnotationShape, CanvasTiles } from './canvasShapes';
import type { CanvasInteraction } from './canvasInteraction';
import { t } from '../i18n/catalog';
import * as styles from './CanvasScreen.css';

export type Props = {
  setSvgRef: (el: SVGSVGElement) => void;
  vb: Accessor<ViewBox>;
  image: Accessor<CanvasImage | undefined>;
  imgLoaded: Accessor<boolean>;
  tool: Accessor<Tool>;
  interaction: Pick<CanvasInteraction,
    'onWheel' | 'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerLeave' | 'isSpaceDown'>;
  // Phase 2 SEAM: `onTileToggle` is today's per-annotator MANUAL tile-complete state
  // (see tileComplete.ts). Grouping/candidate-object work will swap this for a COMPUTED
  // checkmark ("all this tile's marks belong to a candidate object") fed as a derived
  // prop instead — CanvasTiles already renders a non-interactive badge when the toggle
  // is omitted (merge today), so no CanvasStage change is needed for that swap.
  onTileToggle?: (tile: CanvasTile) => void;
  /** The annotations to render for the current image — caller-supplied so annotate
   * (per-annotator, from `image().annotations`) and merge (pooled, cross-annotator)
   * can each pick their own source without CanvasStage knowing about either. */
  annotations: CanvasAnnotation[];
  /** Per-mark colour. Annotate passes a per-label colour fn; merge passes a constant
   * blind colour (see MergeCanvasScreen). */
  annotationColor: (ann: CanvasAnnotation) => string;
  /** MERGE Phase 2a: per-mark erased flag — the mark stays VISIBLE but its `<g>` gets
   * `data-erased="true"` + dotted stroke + reduced opacity (see AnnotationShape). Undef
   * on the annotate side; merge feeds this from its erasures resource. */
  annotationErased?: (ann: CanvasAnnotation) => boolean;
  /** MERGE Phase 1: render every mark identically (outline-only, no fill) so a merger
   * can't tell whose mark is whose — see AnnotationShape's `blind` prop. */
  blind?: boolean;
  /** Overlay slot rendered INSIDE the <svg>, after the annotations — e.g. annotate's
   * SelectionHighlight / LiveDraftOverlay / heatmap layer. Merge injects nothing. The
   * stage itself stays domain-agnostic: it never imports any of those. */
  children?: JSX.Element;
  /** Stage-level slot rendered OUTSIDE the <svg> but inside the (position:relative)
   * stage div — e.g. the admin heatmap's floating control panel. */
  panel?: JSX.Element;
};

/** Shared `<svg>` stage — image + tile overlay + annotations + pointer/wheel wiring —
 * used by both CanvasScreen (annotate) and MergeCanvasScreen (merge). Domain machinery
 * (history, persistence, selection, keyboard, telemetry) stays in the screens; this
 * component only renders and wires the pointer handlers the caller's interaction object
 * already computed. Extracted so the two screens stop hand-rolling their own near-
 * identical `<svg>` block (see CanvasScreen/MergeCanvasScreen `.tsx` for the callers). */
export const CanvasStage: Component<Props> = (props) => (
  <Show when={props.image()} fallback={<div class={styles.stage}>{t('common.loading')}</div>}>
    {(im) => (
      <div class={styles.stage}>
        <svg ref={props.setSvgRef} class={styles.svg}
          viewBox={`${props.vb().x} ${props.vb().y} ${props.vb().w} ${props.vb().h}`}
          preserveAspectRatio="xMidYMid meet"
          onWheel={props.interaction.onWheel}
          onPointerDown={props.interaction.onPointerDown}
          onPointerMove={props.interaction.onPointerMove}
          onPointerUp={props.interaction.onPointerUp}
          onPointerLeave={props.interaction.onPointerLeave}
          classList={{
            [styles.panning]: props.tool() === 'pan',
            [styles.spacePanning]: props.interaction.isSpaceDown() && props.tool() !== 'pan',
            [styles.erasing]: props.tool() === 'eraser',
          }}
        >
          <image href={imageUrls.overview(im().imageId)} x="0" y="0"
            width={im().width} height={im().height} />
          {/* Annotations render BELOW the tile UI (t58) so a painted stroke can't cover the
              tile-complete checkmark and swallow its clicks. CanvasTiles' grid rect is
              fill=none (doesn't block painting); its checkmark stops propagation. */}
          <Show when={props.imgLoaded()}>
            <For each={props.annotations}>
              {(a) => <AnnotationShape ann={a} color={props.annotationColor(a)} blind={props.blind}
                erased={props.annotationErased?.(a)} />}
            </For>
          </Show>
          <CanvasTiles tiles={im().tiles} checkClass={styles.check} onToggle={props.onTileToggle} />
          {props.children}
        </svg>
        {props.panel}
      </div>
    )}
  </Show>
);

export default CanvasStage;
