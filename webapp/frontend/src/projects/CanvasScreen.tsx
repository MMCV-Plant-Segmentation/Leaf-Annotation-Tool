import { type Component, createEffect, createMemo, createResource, createSignal, For, Show, on, onMount, onCleanup } from 'solid-js';
import { useNavigate, useParams } from '@solidjs/router';
import { projectsApi, imageUrls, type CanvasAnnotation, type CanvasImage, type CanvasLesion, type TileStateUpdate } from './api';
import { t } from '../i18n/catalog';
import { type Tool, type ViewBox, AnnotationShape, LesionShape, CanvasTiles, clampRect, buildStrokePath, strokeOutline, mergeTileStates } from './canvasShapes';
import { createCanvasInteraction } from './canvasInteraction';
import { createCanvasHistory } from './canvasHistory';
import { CanvasToolbar } from './CanvasToolbar';
import { currentUser } from '../auth';
import * as styles from './CanvasScreen.css';

const CanvasScreen: Component = () => {
  const params = useParams();
  const nav = useNavigate();
  const batchId = () => params.batchId;
  const annotator = () => currentUser()?.username ?? '';
  const [canvas, { mutate: setCanvas }] = createResource(
    () => { const bid = batchId(); const u = currentUser(); return (bid && u) ? `${bid}|${u.username}` : undefined; },
    (key: string) => { const s = key.indexOf('|'); return projectsApi.batchCanvas(key.slice(0, s), key.slice(s + 1)); }
  );

  const [imgIdx, setImgIdx] = createSignal(0);
  const image = createMemo<CanvasImage | undefined>(() => canvas()?.images[imgIdx()]);
  const [tool, setTool] = createSignal<Tool>('pan');
  const [draft, setDraft] = createSignal<number[][]>([]);
  const [selClass, setSelClass] = createSignal('lesion');
  const [vb, setVb] = createSignal<ViewBox>({ x: 0, y: 0, w: 100, h: 100 });
  const [brushSize, setBrushSize] = createSignal(0);
  // BUGS #20: the lesion/annotation overlay must not paint before the <image> has loaded
  // (else it briefly floats over a blank/late image). Reset only on image src change —
  // never on pan/zoom — so there's no flicker while panning/zooming an already-loaded image.
  const [imgLoaded, setImgLoaded] = createSignal(false);

  let svgRef: SVGSVGElement | undefined;

  const fitImage = () => { const im = image(); if (im) setVb({ x: 0, y: 0, w: im.width, h: im.height }); };
  const imageId = createMemo(() => image()?.imageId);
  createEffect(on(imageId, () => { if (image()) fitImage(); history.reset(); setImgLoaded(false); }));

  const maxBrushSize = createMemo(() => { const im = image(); return im ? Math.round(Math.hypot(im.width, im.height)) : 1000; });
  createEffect(on(canvas, (c) => {
    if (!c || brushSize() !== 0) return;
    const tile = c.images.flatMap((im) => im.tiles)[0];
    setBrushSize(Math.max(1, Math.round(Math.hypot(tile?.w ?? 100, tile?.h ?? 100) * 0.1)));
  }));

  const updateImg = (fn: (im: CanvasImage) => CanvasImage) =>
    setCanvas((c) => c && ({ ...c, images: c.images.map((im, i) => i === imgIdx() ? fn(im) : im) }));

  const applyLesions = (ls: CanvasLesion[]) => updateImg((im) => ({ ...im, lesions: ls }));

  // BUGS #16: a draw that lands in an already-completed tile re-opens it server-side.
  const applyTileStates = (updates: TileStateUpdate[]) =>
    updateImg((im) => ({ ...im, tiles: mergeTileStates(im.tiles, updates) }));

  const history = createCanvasHistory(
    () => canvas()?.projectId ?? '',
    updateImg,
  );

  // ── persistence ──
  const commit = async (kind: string, points: number[][], passNo?: number, strokeWidth?: number) => {
    const im = image(); const c = canvas();
    if (!im || !c) return;
    try {
      // Compute the perfect-freehand outline polygon for stroke commits so the server
      // stores and uses it for lesion geometry (fills loops, matches rendered shape).
      const outline = (kind === 'stroke' && strokeWidth != null)
        ? strokeOutline(points, strokeWidth)
        : undefined;
      const ann = await projectsApi.createAnnotation(c.projectId, {
        imageId: im.imageId, annotator: annotator(), kind, points, passNo,
        label: selClass(), viewport: clampRect(vb(), im.width, im.height),
        strokeWidth: kind === 'stroke' ? strokeWidth : undefined,
        outline,
      });
      pushAnnotation(ann);
      applyLesions(ann.lesions ?? []);
      applyTileStates(ann.tileStates ?? []);
      history.push({ kind: 'draw', ann });
    } catch (ex) {
      alert(ex instanceof Error ? ex.message : 'Save failed');
    }
  };

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

  const pushAnnotation = (ann: CanvasAnnotation) => {
    updateImg((im) => ({ ...im, annotations: [...im.annotations, ann] }));
  };

  // Erase all member strokes of a lesion (eraser tool).
  const eraseLesion = async (lesion: CanvasLesion) => {
    const im = image(); if (!im) return;
    await history.erase(im.annotations.filter((a) => lesion.memberIds.includes(a.id)));
  };

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
        annotator={annotator() ?? ''}
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
                width={im().width} height={im().height}
                onLoad={() => setImgLoaded(true)} />
              <CanvasTiles tiles={im().tiles} checkClass={styles.check}
                onToggle={(tile) => void toggleTile(tile)} />
              <Show when={imgLoaded()}>
                <For each={im().lesions}>
                  {(l) => <LesionShape lesion={l}
                    onErase={tool() === 'eraser' ? () => void eraseLesion(l) : undefined} />}
                </For>
                <For each={im().annotations.filter((a) => a.kind !== 'stroke')}>
                  {(a) => <AnnotationShape ann={a}
                    onErase={tool() === 'eraser' ? () => void history.erase([a]) : undefined} />}
                </For>
              </Show>
              <Show when={draft().length > 0 && tool() === 'brush'}>
                <path d={buildStrokePath(draft(), brushSize(), false)} fill="rgba(37,99,235,0.35)" />
              </Show>
              <Show when={tool() === 'brush' && interaction.hoverImg()}>
                {(c) => <circle cx={c()[0]} cy={c()[1]} r={brushSize() / 2} fill="none" stroke="rgba(37,99,235,0.85)" stroke-width="1.5" vector-effect="non-scaling-stroke" pointer-events="none" />}
              </Show>
            </svg>
          </div>
        )}
      </Show>

      <div class={styles.help}>{t('canvas.help')}</div>
    </div>
  );
};

export default CanvasScreen;
