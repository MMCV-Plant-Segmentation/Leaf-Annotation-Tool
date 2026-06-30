import { type Component, createEffect, createMemo, createResource, createSignal, For, Show, on, onMount, onCleanup } from 'solid-js';
import { useNavigate, useParams } from '@solidjs/router';
import { projectsApi, imageUrls, type CanvasAnnotation, type CanvasImage, type CanvasTile } from './api';
import { t } from '../i18n/catalog';
import { type Tool, type ViewBox, TILE_COLORS, AnnotationShape, clampRect, buildStrokePath } from './canvasShapes';
import { createCanvasInteraction } from './canvasInteraction';
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
  const [selAnn, setSelAnn] = createSignal<string | null>(null);
  const [vb, setVb] = createSignal<ViewBox>({ x: 0, y: 0, w: 100, h: 100 });
  const [brushSize, setBrushSize] = createSignal(0);

  let svgRef: SVGSVGElement | undefined;

  const fitImage = () => { const im = image(); if (im) setVb({ x: 0, y: 0, w: im.width, h: im.height }); };
  const imageId = createMemo(() => image()?.imageId);
  createEffect(on(imageId, () => { if (image()) fitImage(); }));

  // Max brush size = image diagonal; default = 10% of tile diagonal (set once on canvas load)
  const maxBrushSize = createMemo(() => { const im = image(); return im ? Math.round(Math.hypot(im.width, im.height)) : 1000; });
  createEffect(on(canvas, (c) => {
    if (!c || brushSize() !== 0) return;
    const tile = c.images.flatMap((im) => im.tiles)[0];
    setBrushSize(Math.max(1, Math.round(Math.hypot(tile?.w ?? 100, tile?.h ?? 100) * 0.1)));
  }));

  // ── persistence ──
  const commit = async (kind: string, points: number[][], passNo?: number, strokeWidth?: number) => {
    const im = image(); const c = canvas();
    if (!im || !c) return;
    try {
      const ann = await projectsApi.createAnnotation(c.projectId, {
        imageId: im.imageId, annotator: annotator(), kind, points, passNo,
        label: selClass(), viewport: clampRect(vb(), im.width, im.height),
        strokeWidth: kind === 'stroke' ? strokeWidth : undefined,
      });
      pushAnnotation(ann);
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
    if (e.key === 'b' || e.key === 'B') { setTool('brush'); setDraft([]); }
    if (e.key === 'h' || e.key === 'H') { setTool('pan'); setDraft([]); }
    if ((e.ctrlKey || e.metaKey) && e.key === '0') { e.preventDefault(); fitImage(); }
    interaction.handleKeyDown(e);
  };
  const onKeyUp = (e: KeyboardEvent) => interaction.handleKeyUp(e);
  onMount(() => { window.addEventListener('keydown', onKeyDown); window.addEventListener('keyup', onKeyUp); });
  onCleanup(() => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp); });

  const pushAnnotation = (ann: CanvasAnnotation) => {
    setCanvas((c) => c && ({
      ...c,
      images: c.images.map((im, i) => i === imgIdx() ? { ...im, annotations: [...im.annotations, ann] } : im),
    }));
  };

  const deleteSelected = async () => {
    const id = selAnn(); if (!id) return;
    await projectsApi.deleteAnnotation(id);
    setSelAnn(null);
    setCanvas((c) => c && ({
      ...c,
      images: c.images.map((im, i) => i === imgIdx()
        ? { ...im, annotations: im.annotations.filter((a) => a.id !== id) } : im),
    }));
  };

  const toggleTile = async (tile: CanvasTile) => {
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
        selAnn={selAnn} imgIdx={imgIdx} imgCount={canvas()?.images.length ?? 0}
        onBack={() => nav(-1)} onFit={fitImage}
        onDelete={() => void deleteSelected()}
        onImgPrev={() => setImgIdx((i) => i - 1)} onImgNext={() => setImgIdx((i) => i + 1)}
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
              classList={{
                [styles.panning]: tool() === 'pan',
                [styles.spacePanning]: interaction.isSpaceDown() && tool() !== 'pan',
              }}
            >
              <image href={imageUrls.overview(im().imageId)} x="0" y="0"
                width={im().width} height={im().height} />
              <For each={im().tiles}>
                {(tile) => (
                  <g>
                    <rect x={tile.x} y={tile.y} width={tile.w} height={tile.h}
                      fill="none" stroke={TILE_COLORS[tile.state ?? 'assigned']}
                      stroke-width="2" vector-effect="non-scaling-stroke"
                      stroke-dasharray={tile.state === 'completed' ? undefined : '6 4'} />
                    <circle data-testid="tile-complete" class={styles.check}
                      cx={tile.x + tile.w} cy={tile.y} r="8"
                      fill={tile.state === 'completed' ? '#16a34a' : '#fff'}
                      stroke="#16a34a" stroke-width="1.5" vector-effect="non-scaling-stroke"
                      onPointerDown={(e) => { e.stopPropagation(); void toggleTile(tile); }} />
                  </g>
                )}
              </For>
              <For each={im().annotations}>
                {(a) => <AnnotationShape ann={a} selected={selAnn() === a.id}
                  onSelect={() => setSelAnn(a.id)} />}
              </For>
              {/* Live brush draft rendered via perfect-freehand */}
              <Show when={draft().length > 0 && tool() === 'brush'}>
                <path d={buildStrokePath(draft(), brushSize(), false)} fill="rgba(37,99,235,0.7)" />
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
