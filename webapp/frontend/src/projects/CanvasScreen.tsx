import { type Component, createEffect, createMemo, createResource, createSignal, Show, on } from 'solid-js';
import { useNavigate, useParams } from '@solidjs/router';
import { projectsApi, type CanvasImage, type Label } from './api';
import { t } from '../i18n/catalog';
import { type Tool, type ViewBox, LiveDraftOverlay } from './canvasShapes';
import { SelectionHighlight } from './SelectionHighlight';
import { hitTestAnnotation } from './lesionSelect';
import { createCanvasInteraction } from './canvasInteraction';
import { createCanvasHistory } from './canvasHistory';
import { createCanvasPersistence } from './canvasPersistence';
import { createRelabelDropdown } from './relabelDropdown';
import { createCanvasKeyboard } from './canvasKeyboard';
import { createTileToggle } from './tileComplete';
import { createAnnotatorSelect } from './annotatorSelect';
import { createImageDecodeGate } from './imageDecodeGate';
import { createViewportTelemetry } from './viewportTelemetry';
import { CanvasToolbar } from './CanvasToolbar';
import { CanvasStage } from './CanvasStage';
import { CanvasHints } from './CanvasHints';
import CanvasLegend from './CanvasLegend';
import { adminReadOnlyCommit } from './adminReadOnly';
import { createViewportHeatmap, ViewportHeatmapLayer, ViewportHeatmapPanel } from './ViewportHeatmapOverlay';
import * as styles from './CanvasScreen.css';

// Annotate enables the full tool set (unchanged behavior) — see canvasToolRegistry.ts.
const ANNOTATE_TOOLS: Tool[] = ['select', 'pan', 'brush', 'eraser'];

const CanvasScreen: Component = () => {
  const params = useParams();
  const nav = useNavigate();
  const batchId = () => params.batchId;
  // BUGS #15: non-admin annotates as self; admin gets a read-only roster picker (see annotatorSelect.ts).
  const { annotator, isAdmin, roster, select: selectAnnotator } = createAnnotatorSelect(() => params.id, batchId, () => image()?.imageId);
  const [canvas, { mutate: setCanvas }] = createResource(
    () => { const bid = batchId(); const ann = annotator(); return (bid && ann) ? `${bid}|${ann}` : undefined; },
    (key: string) => { const s = key.indexOf('|'); return projectsApi.batchCanvas(key.slice(0, s), key.slice(s + 1)); }
  );

  const [imgIdx, setImgIdx] = createSignal(0);
  const image = createMemo<CanvasImage | undefined>(() => canvas()?.images[imgIdx()]);
  const [tool, setTool] = createSignal<Tool>('select');
  const [selId, setSelId] = createSignal<string | null>(null);
  const [draft, setDraft] = createSignal<number[][]>([]);
  // Compound labels Phase 2b: `paintLabel` is the last compound the user MANUALLY chose
  // for painting (the active brush label) — it drives actual paint commits and is what
  // the drop-down restores to on deselect. See `dropdownLabel`/`pickDropdown` below for
  // the drop-down's dual role (paint picker + relabel picker).
  const [paintLabel, setPaintLabel] = createSignal('');
  const [vb, setVb] = createSignal<ViewBox>({ x: 0, y: 0, w: 100, h: 100 });
  const [brushSize, setBrushSize] = createSignal(0);
  // BUGS #20: the annotation overlay must not paint before the <image> is decode-ready
  // (else it briefly floats over a blank/late image). imgLoaded is driven by decode(),
  // not the SVG <image> onLoad, and is keyed to imageId only — never on pan/zoom — so
  // there's no flicker while panning/zooming an already-loaded image. See imageDecodeGate.ts.
  const imageId = createMemo(() => image()?.imageId);
  const imgLoaded = createImageDecodeGate(imageId);

  let svgRef: SVGSVGElement | undefined;

  const fitImage = () => { const im = image(); if (im) setVb({ x: 0, y: 0, w: im.width, h: im.height }); };
  createEffect(on(imageId, () => { if (image()) fitImage(); history.reset(); setSelId(null); }));

  const maxBrushSize = createMemo(() => { const im = image(); return im ? Math.round(Math.hypot(im.width, im.height)) : 1000; });
  createEffect(on(canvas, (c) => {
    if (!c || brushSize() !== 0) return;
    const tile = c.images.flatMap((im) => im.tiles)[0];
    setBrushSize(Math.max(1, Math.round(Math.hypot(tile?.w ?? 100, tile?.h ?? 100) * 0.1)));
  }));

  const updateImg = (fn: (im: CanvasImage) => CanvasImage) =>
    setCanvas((c) => c && ({ ...c, images: c.images.map((im, i) => i === imgIdx() ? fn(im) : im) }));

  const history = createCanvasHistory(
    () => canvas()?.projectId ?? '',
    updateImg,
  );

  const { commit, relabel } = createCanvasPersistence({
    image, getProjectId: () => canvas()?.projectId, annotator, selClass: paintLabel, vb, updateImg, history,
  });
  const { dropdownLabel, pickDropdown } = createRelabelDropdown({ selId, image, paintLabel, setPaintLabel, relabel });

  // BUGS #15: an admin viewing another user's annotations may look but must NOT add or
  // delete anything for that user. When isAdmin() is true, the commit handed to the canvas
  // interaction is a no-op, so drawing/erasing produces no server write — regardless of
  // which tool is selected. (Admin's API-level ability is intentionally left intact; this
  // is FE enforcement only, consistent with readOnly={isAdmin()} used elsewhere.)
  const interaction = createCanvasInteraction({
    getSvg: () => svgRef, vb, setVb, tool, draft, setDraft,
    brushSize, setBrushSize, maxBrushSize,
    commit: (kind, points, passNo, strokeWidth) => adminReadOnlyCommit(isAdmin(), commit, kind, points, passNo, strokeWidth),
    onSelect: (pt) => setSelId(hitTestAnnotation(image()?.annotations ?? [], pt[0], pt[1])),
  });

  // Best-effort viewport (pan/zoom) telemetry — see viewportTelemetry.ts. No UI; feeds
  // future analysis of per-user "vision level" tile sizing.
  createViewportTelemetry({ getProjectId: () => canvas()?.projectId, imageId, vb, getSvg: () => svgRef });

  createCanvasKeyboard({ isAdmin, interaction, history, tool, setTool, setDraft, setSelId, fitImage });

  // Admin-only viewport-attention HEATMAP overlay (dwell x zoom-closeness). The math
  // lives in viewportHeatmap.ts; the SVG layer + control panel in ViewportHeatmapOverlay.
  // Non-admin annotators never get this — it's analysis data, gated admin-only backend-side.
  const heat = isAdmin()
    ? createViewportHeatmap(
        () => canvas()?.projectId ?? '',
        () => image()?.imageId ?? '',
        () => image()?.width ?? 0,
        () => image()?.height ?? 0)
    : null;

  const { toggle: toggleTile, error: tileErr } = createTileToggle(imgIdx, setCanvas);

  const classOptions = (): Label[] => canvas()?.classes ?? [];

  // Taxonomy v2: a lesion renders in its SNAPSHOT colour (captured at assign time) so a
  // later preset edit/delete never orphans its colour. Lesions without a snapshot (legacy
  // free-text) fall back to the matching compound's colour, then the canonical blue.
  const labelColor = (label: string | null, snap?: string | null): string => {
    if (snap) return snap;
    const match = (canvas()?.classes ?? []).find((c) => c.name === label);
    return match ? match.color : '#2563eb';
  };

  // Keep paintLabel valid against the project's labels. The backend is LENIENT (a label
  // need not be configured), so an out-of-set paintLabel is preserved as a free-text
  // option rather than dropped — but when empty, default to the first configured label.
  createEffect(on(classOptions, (opts) => {
    if (!paintLabel() && opts.length) setPaintLabel(opts[0].name);
  }));

  return (
    <div class={styles.wrap} data-screen="canvas">
      <Show when={!annotator()}>
        <div class={styles.banner}>{t('canvas.noAnnotator')}</div>
      </Show>
      <Show when={tileErr()}>
        <div class={styles.banner} data-testid="tile-error" role="alert">{tileErr()}</div>
      </Show>
      <CanvasToolbar
        tools={ANNOTATE_TOOLS}
        tool={tool} setTool={(tl) => { setTool(tl); setDraft([]); }}
        annotator={annotator()} readOnly={isAdmin()} roster={roster} onSelectAnnotator={selectAnnotator}
        brushSize={brushSize} setBrushSize={setBrushSize} maxBrushSize={maxBrushSize}
        selClass={dropdownLabel} setSelClass={pickDropdown} classOptions={classOptions}
        imgIdx={imgIdx} imgCount={canvas()?.images.length ?? 0}
        onBack={() => nav(-1)} onFit={fitImage}
        onImgPrev={() => setImgIdx((i) => i - 1)} onImgNext={() => setImgIdx((i) => i + 1)}
        onUndo={() => void history.undo()} onRedo={() => void history.redo()}
        canUndo={history.canUndo} canRedo={history.canRedo}
      />

      <CanvasStage
        setSvgRef={(el) => { svgRef = el; }}
        vb={vb} image={image} imgLoaded={imgLoaded} tool={tool} interaction={interaction}
        onTileToggle={isAdmin() ? undefined : (tile) => void toggleTile(tile)}
        annotations={image()?.annotations ?? []}
        annotationColor={(a) => labelColor(a.label, a.labelColor)}
        panel={heat ? <ViewportHeatmapPanel heat={heat} /> : undefined}
      >
        <Show when={imgLoaded() && selId()}>{(id) =>
          <SelectionHighlight ann={image()!.annotations.find((a) => a.id === id())!} />
        }</Show>
        <LiveDraftOverlay tool={tool()} draft={draft()} brushSize={brushSize()}
          hover={interaction.hoverImg()} />
        {heat && <ViewportHeatmapLayer heat={heat} />}
      </CanvasStage>

      <CanvasLegend annotations={image()?.annotations ?? []} classes={canvas()?.classes ?? []} />
      <CanvasHints vb={vb} />
    </div>
  );
};

export default CanvasScreen;
