import { type Component, createEffect, createMemo, createResource, createSignal, For, Show, on, onMount, onCleanup } from 'solid-js';
import { useNavigate, useParams } from '@solidjs/router';
import { projectsApi, imageUrls, type CanvasImage } from './api';
import { t } from '../i18n/catalog';
import { type Tool, type ViewBox, AnnotationShape, CanvasTiles, buildStrokePath } from './canvasShapes';
import { createCanvasInteraction } from './canvasInteraction';
import { createCanvasHistory } from './canvasHistory';
import { createCanvasPersistence } from './canvasPersistence';
import { createAnnotatorSelect } from './annotatorSelect';
import { createImageDecodeGate } from './imageDecodeGate';
import { CanvasToolbar } from './CanvasToolbar';
import { CanvasHints } from './CanvasHints';
import * as styles from './CanvasScreen.css';

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
  const [tool, setTool] = createSignal<Tool>('pan');
  const [draft, setDraft] = createSignal<number[][]>([]);
  const [selClass, setSelClass] = createSignal('lesion');
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
  createEffect(on(imageId, () => { if (image()) fitImage(); history.reset(); }));

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

  const { commit } = createCanvasPersistence({
    image, getProjectId: () => canvas()?.projectId, annotator, selClass, vb, updateImg, history,
  });

  const interaction = createCanvasInteraction({
    getSvg: () => svgRef, vb, setVb, tool, draft, setDraft,
    brushSize, setBrushSize, maxBrushSize,
    commit: (kind, points, passNo, strokeWidth) => void commit(kind, points, passNo, strokeWidth),
  });

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') interaction.finishDraft();
    if (e.key === 'Escape') setDraft([]);
    if ((e.ctrlKey || e.metaKey) && e.key === '0') { e.preventDefault(); fitImage(); }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z') { e.preventDefault(); void history.undo(); }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'z') { e.preventDefault(); void history.redo(); }
    if (e.ctrlKey && !e.metaKey && e.key === 'y') { e.preventDefault(); void history.redo(); }
    interaction.handleKeyDown(e);
  };
  const onKeyUp = (e: KeyboardEvent) => interaction.handleKeyUp(e);
  onMount(() => { window.addEventListener('keydown', onKeyDown); window.addEventListener('keyup', onKeyUp); });
  onCleanup(() => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp); });

  const toggleTile = async (tile: import('./api').CanvasTile) => {
    if (!tile.annotatorTileId) return;
    const next = tile.state === 'completed' ? 'assigned' : 'completed';
    await projectsApi.setTileState(tile.annotatorTileId, next);
    setCanvas((c) => c && ({
      ...c,
      images: c.images.map((im, i) => i === imgIdx()
        ? { ...im, tiles: im.tiles.map((tl) => tl.tileId === tile.tileId ? { ...tl, state: next } : tl) } : im),
    }));
  };

  const classOptions = (): string[] => {
    const fromProject = canvas()?.classes ?? [];
    const base = fromProject.length > 0 ? fromProject : ['lesion', 'midrib', 'uncertain'];
    return base.includes(selClass()) ? base : [selClass(), ...base];
  };

  return (
    <div class={styles.wrap} data-screen="canvas">
      <Show when={!annotator()}>
        <div class={styles.banner}>{t('canvas.noAnnotator')}</div>
      </Show>
      <CanvasToolbar
        tool={tool} setTool={(tl) => { setTool(tl); setDraft([]); }}
        annotator={annotator()} readOnly={isAdmin()} roster={roster} onSelectAnnotator={selectAnnotator}
        brushSize={brushSize} setBrushSize={setBrushSize} maxBrushSize={maxBrushSize}
        selClass={selClass} setSelClass={setSelClass} classOptions={classOptions}
        imgIdx={imgIdx} imgCount={canvas()?.images.length ?? 0}
        onBack={() => nav(-1)} onFit={fitImage}
        onImgPrev={() => setImgIdx((i) => i - 1)} onImgNext={() => setImgIdx((i) => i + 1)}
        onUndo={() => void history.undo()} onRedo={() => void history.redo()}
        canUndo={history.canUndo} canRedo={history.canRedo}
      />

      <Show when={image()} fallback={<div class={styles.stage}>{t('common.loading')}</div>}>
        {(im) => (
          <div class={styles.stage}>
            <svg ref={svgRef} class={styles.svg}
              viewBox={`${vb().x} ${vb().y} ${vb().w} ${vb().h}`}
              preserveAspectRatio="xMidYMid meet"
              onWheel={interaction.onWheel}
              onPointerDown={interaction.onPointerDown}
              onPointerMove={interaction.onPointerMove}
              onPointerUp={interaction.onPointerUp}
              onPointerLeave={interaction.onPointerLeave}
              classList={{
                [styles.panning]: tool() === 'pan',
                [styles.spacePanning]: interaction.isSpaceDown() && tool() !== 'pan',
                [styles.erasing]: tool() === 'eraser',
              }}
            >
              <image href={imageUrls.overview(im().imageId)} x="0" y="0"
                width={im().width} height={im().height} />
              <CanvasTiles tiles={im().tiles} checkClass={styles.check}
                onToggle={isAdmin() ? undefined : (tile) => void toggleTile(tile)} />
              <Show when={imgLoaded()}>
                <For each={im().annotations}>{(a) => <AnnotationShape ann={a} />}</For>
              </Show>
              <Show when={draft().length > 0 && (tool() === 'brush' || tool() === 'eraser')}>
                <path d={buildStrokePath(draft(), brushSize(), false)}
                  fill={tool() === 'eraser' ? 'rgba(220,38,38,0.35)' : 'rgba(37,99,235,0.35)'} />
              </Show>
              <Show when={(tool() === 'brush' || tool() === 'eraser') && interaction.hoverImg()}>
                {(c) => <circle cx={c()[0]} cy={c()[1]} r={brushSize() / 2} fill="none"
                  stroke={tool() === 'eraser' ? 'rgba(220,38,38,0.85)' : 'rgba(37,99,235,0.85)'}
                  stroke-width="1.5" vector-effect="non-scaling-stroke" pointer-events="none" />}
              </Show>
            </svg>
          </div>
        )}
      </Show>

      <CanvasHints vb={vb} />
    </div>
  );
};

export default CanvasScreen;
