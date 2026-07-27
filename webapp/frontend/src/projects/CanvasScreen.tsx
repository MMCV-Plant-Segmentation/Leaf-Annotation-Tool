import { type Component, createEffect, createMemo, createResource, createSignal, Show, on } from 'solid-js';
import { useNavigate, useParams } from '@solidjs/router';
import { projectsApi, type CanvasImage, type Label } from './api';
import { t } from '../i18n/catalog';
import { type Tool, type ViewBox } from './canvasShapes';
import { LiveDraftOverlay } from './LiveDraftOverlay';
import { SelectionHighlight } from './SelectionHighlight';
import { hitTestAnnotation } from './lesionSelect';
import { VertexHandles } from './VertexHandles';
import { createCanvasInteraction } from './canvasInteraction';
import { createCanvasHistory } from './canvasHistory';
import { createCanvasPersistence } from './canvasPersistence';
import { createCanvasSocket } from './canvasSocket';
import { createRelabelDropdown } from './relabelDropdown';
import { createCanvasKeyboard } from './canvasKeyboard';
import { createTileToggle } from './tileComplete';
import { createAnnotatorSelect } from './annotatorSelect';
import { createImageDecodeGate } from './imageDecodeGate';
import { createViewportTelemetry } from './viewportTelemetry';
import { createViewportUrlSync } from './viewportUrlSync';
import { createUnsavedGuard } from './canvasUnsavedGuard';
import { CanvasToolbar } from './CanvasToolbar';
import { CanvasStage } from './CanvasStage';
import { CanvasHints } from './CanvasHints';
import CanvasLegend from './CanvasLegend';
import { adminReadOnlyCommit } from './adminReadOnly';
import { createViewportHeatmap, ViewportHeatmapLayer, ViewportHeatmapPanel } from './ViewportHeatmapOverlay';
import { createPolylineSnapState } from './canvasSnapIndex';
import { makeFinishOrSplice } from './canvasSplice';
import { createSelectionResize } from './canvasSelectionResize';
import { buildClassOptions } from './canvasClassOptions';
import { createTileNav } from './canvasTileNav';
import { createPersistedBrushSize } from './brushSizePersistSync';
import { goBack, projectHubRoute } from './canvasBackRoute';
import * as styles from './CanvasScreen.css';

// Annotate enables the full tool set; 'polyline' is the a11y click-brush (feature #40).
const ANNOTATE_TOOLS: Tool[] = ['select', 'pan', 'brush', 'polyline', 'eraser'];

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
  // `paintLabel` = the last compound the user chose for painting (drives commits + pickDropdown).
  const [paintLabel, setPaintLabel] = createSignal('');
  const [vb, setVb] = createSignal<ViewBox>({ x: 0, y: 0, w: 100, h: 100 });
  const [brushSize, setBrushSize] = createPersistedBrushSize(); // t93: persist across reloads
  // t50 phase 2b: draw-time vertex snapping state (see canvasSnapIndex.ts).
  const { draftRefs, setDraftRefs, snapIndex, snapRadiusImg } = createPolylineSnapState(image, brushSize);
  const imageId = createMemo(() => image()?.imageId);  // BUGS #20: gate paint on decode-ready
  const imgLoaded = createImageDecodeGate(imageId);

  let svgRef: SVGSVGElement | undefined;
  const fitImage = () => { const im = image(); if (im) setVb({ x: 0, y: 0, w: im.width, h: im.height }); };
  // t139: prev/next step a FLAT tile list (canvasTileNav.ts), framing the landed tile.
  // Initial open/same-image stays whole-image-fit; consumeFraming() lets a tile-nav image
  // switch skip that fit so the tile frame wins instead.
  const { tileIndex, flatTiles, tilePrev, tileNext, consumeFraming } = createTileNav(() => canvas()?.images, imgIdx, setImgIdx, setVb);
  createEffect(on(imageId, () => {
    if (!image()) return;
    if (!consumeFraming()) fitImage();
    history.reset(); setSelId(null);
  }));
  const maxBrushSize = createMemo(() => { const im = image(); return im ? Math.round(Math.hypot(im.width, im.height)) : 1000; });
  createEffect(on(canvas, (c) => {
    if (!c || brushSize() !== 0) return;
    const tile = c.images.flatMap((im) => im.tiles)[0];
    setBrushSize(Math.max(1, Math.round(Math.hypot(tile?.w ?? 100, tile?.h ?? 100) * 0.1)));
  }));
  const updateImg = (fn: (im: CanvasImage) => CanvasImage) => setCanvas((c) => c && ({ ...c, images: c.images.map((im, i) => i === imgIdx() ? fn(im) : im) }));
  // Phase 1 (feat/annotation-ws): ONE WebSocket per canvas — create/edit/reverse channel.
  const socket = createCanvasSocket({ projectId: () => canvas()?.projectId, imageId });
  const history = createCanvasHistory(() => canvas()?.projectId ?? '', updateImg, socket);
  const { commit, relabel, editStroke, moveSharedVertex, polylineStep, resetPolyline,
    finishPolyline, splicePolyline, polylineStrokeId } = createCanvasPersistence({
    image, getProjectId: () => canvas()?.projectId, annotator, selClass: paintLabel, vb, updateImg, history, socket, setSelectedId: setSelId, setDraftRefs,
  });
  const finishOrSplice = makeFinishOrSplice({  // t67: splice run into existing stroke, else finish
    draft, draftRefs, annotations: () => image()?.annotations ?? [],
    runStrokeId: polylineStrokeId, brushSize, splice: splicePolyline, finish: finishPolyline,
  });
  const selResize = createSelectionResize({ selected: () => image()?.annotations.find((a) => a.id === selId()), editStroke }); // t65
  const { dropdownLabel, pickDropdown } = createRelabelDropdown({ selId, image, paintLabel, setPaintLabel, relabel });
  createEffect(on(tool, (tl) => { if (tl !== 'polyline') resetPolyline(); })); // leaving polyline ends the session

  // BUGS #15: admin viewer is FE read-only — commit + polylineStep no-op when isAdmin().
  const interaction = createCanvasInteraction({
    getSvg: () => svgRef, vb, setVb, tool, draft, setDraft, draftRefs, setDraftRefs, snapIndex, snapRadiusImg,
    brushSize, setBrushSize, maxBrushSize, resizeSelected: selResize.resizeSelected,
    commit: (kind, points, passNo, strokeWidth, tool, samples) => adminReadOnlyCommit(isAdmin(), commit, kind, points, passNo, strokeWidth, tool, samples),
    polylineStep: (pts, sw, refs) => { if (!isAdmin()) polylineStep(pts, sw, refs); },  // BUGS #15 admin viewer no-op
    onSelect: (pt) => setSelId(hitTestAnnotation(image()?.annotations ?? [], pt[0], pt[1])),
  });
  // Best-effort viewport telemetry, URL persist/restore (t92), + an unsaved-op unload guard.
  createViewportTelemetry({ getProjectId: () => canvas()?.projectId, imageId, vb, getSvg: () => svgRef, isAdmin, socket });
  createViewportUrlSync({ imageId, vb, setVb });
  createUnsavedGuard({ hasPending: () => socket.hasPending(), message: () => t('canvas.unsavedWarn') });

  createCanvasKeyboard({ isAdmin, interaction, history, tool, setTool, setDraft, setDraftRefs, setSelId, fitImage, draft, finishPolyline: finishOrSplice });

  // a11y #40 v1b: the selected stroke-mask annotation (for vertex handles), if any.
  const selectedStrokeAnn = createMemo(() => {
    const id = selId(); if (!id) return undefined;
    const a = image()?.annotations.find((x) => x.id === id);
    return a?.kind === 'stroke' && (a.strokes?.length ?? 0) > 0 ? a : undefined;
  });
  // "meet" fits to the more-constraining axis → image-px-per-screen-px = max of both ratios.
  const imgPerScreenPx = () =>
    svgRef ? Math.max(vb().w / svgRef.clientWidth, vb().h / svgRef.clientHeight) : 1;

  // Admin-only viewport-attention HEATMAP overlay (math in viewportHeatmap.ts); gated
  // admin-only backend-side since it's analysis data non-admin annotators never see.
  const heat = isAdmin()
    ? createViewportHeatmap(
        () => canvas()?.projectId ?? '',
        () => image()?.imageId ?? '',
        () => image()?.width ?? 0,
        () => image()?.height ?? 0,
        annotator)
    : null;

  const { toggle: toggleTile, error: tileErr } = createTileToggle(imgIdx, setCanvas, annotator);

  const classOptions = (): Label[] => buildClassOptions(canvas()?.classes ?? [], canvas()?.broken ?? []);
  // Taxonomy v2: a lesion renders in its SNAPSHOT colour; legacy free-text falls back to
  // the matching compound's colour, then the canonical blue.
  const labelColor = (label: string | null, snap?: string | null): string => {
    if (snap) return snap;
    const match = (canvas()?.classes ?? []).find((c) => c.name === label);
    return match ? match.color : '#2563eb';
  };

  // Backend is LENIENT (a label need not be configured); default paintLabel when empty.
  createEffect(on(classOptions, (opts) => {
    if (!paintLabel() && opts.length) setPaintLabel(opts[0].name);
  }));

  return (
    <div class={styles.wrap}>
      <Show when={!annotator()}>
        <div class={styles.banner}>{t('canvas.noAnnotator')}</div>
      </Show>
      <Show when={tileErr()}>
        <div class={styles.banner} data-testid="tile-error" role="alert">{tileErr()}</div>
      </Show>
      <CanvasToolbar
        tools={ANNOTATE_TOOLS}
        tool={tool} setTool={(tl) => { setTool(tl); setDraft([]); setDraftRefs([]); }}
        annotator={annotator()} readOnly={isAdmin()} roster={roster} onSelectAnnotator={selectAnnotator}
        brushSize={brushSize} setBrushSize={setBrushSize} maxBrushSize={maxBrushSize}
        selectionSize={selResize.selectionSize} setSelectionSize={selResize.setSelectionSize}
        selClass={dropdownLabel} setSelClass={pickDropdown} classOptions={classOptions}
        imgIdx={tileIndex} imgCount={flatTiles().length}
        onBack={() => goBack(nav, projectHubRoute(params.id))} onFit={fitImage}
        onImgPrev={tilePrev} onImgNext={tileNext}
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
        <Show when={imgLoaded() && image()?.annotations.find((a) => a.id === selId())}>{(sel) =>
          <SelectionHighlight ann={sel()} />
        }</Show>
        <Show when={imgLoaded() && tool() === 'select' && selectedStrokeAnn()}>{(ann) =>
          <VertexHandles ann={ann()} scale={imgPerScreenPx} toImage={interaction.toImage}
            onCommit={(sid, tl, pts, sw) => void editStroke(sid, tl, pts, sw)}
            allAnnotations={() => image()?.annotations ?? []}
            onMoveSharedVertex={(vid, b, a) => void moveSharedVertex(vid, b, a)} />
        }</Show>
        <LiveDraftOverlay tool={tool()} draft={draft()} brushSize={brushSize()}
          hover={interaction.hoverImg()} color={labelColor(paintLabel())} />
        {heat && <ViewportHeatmapLayer heat={heat} />}
      </CanvasStage>

      <CanvasLegend annotations={image()?.annotations ?? []} classes={canvas()?.classes ?? []} />
      <CanvasHints vb={vb} />
    </div>
  );
};

export default CanvasScreen;
