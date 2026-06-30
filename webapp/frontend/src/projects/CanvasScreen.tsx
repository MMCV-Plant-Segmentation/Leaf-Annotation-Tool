import { type Component, createEffect, createMemo, createResource, createSignal, For, Show, on, onMount, onCleanup } from 'solid-js';
import { useNavigate, useParams, useSearchParams } from '@solidjs/router';
import { projectsApi, imageUrls, type CanvasAnnotation, type CanvasImage, type CanvasTile } from './api';
import { t } from '../i18n/catalog';
import { type Tool, type ViewBox, TILE_COLORS, AnnotationShape, clampRect } from './canvasShapes';
import { createCanvasInteraction } from './canvasInteraction';
import * as styles from './CanvasScreen.css';

const CanvasScreen: Component = () => {
  const params = useParams();
  const [search] = useSearchParams();
  const nav = useNavigate();
  const batchId = () => params.batchId;
  const annotator = () => (search.as as string) || '';

  const [canvas, { mutate: setCanvas }] =
    createResource(batchId, (bid: string) => projectsApi.batchCanvas(bid, annotator()));

  const [imgIdx, setImgIdx] = createSignal(0);
  const image = createMemo<CanvasImage | undefined>(() => canvas()?.images[imgIdx()]);

  const [tool, setTool] = createSignal<Tool>('pan');
  const [draft, setDraft] = createSignal<number[][]>([]);
  const [selClass, setSelClass] = createSignal('lesion');
  const [selAnn, setSelAnn] = createSignal<string | null>(null);
  const [vb, setVb] = createSignal<ViewBox>({ x: 0, y: 0, w: 100, h: 100 });

  let svgRef: SVGSVGElement | undefined;

  // Initialize the viewBox to the whole image whenever the image changes.
  const fitImage = () => {
    const im = image();
    if (im) setVb({ x: 0, y: 0, w: im.width, h: im.height });
  };
  // Re-fit only when the displayed image changes identity, not on every annotation update.
  createEffect(on(() => image()?.imageId, () => { if (image()) fitImage(); }));

  // ── persistence ──
  const commit = async (kind: string, points: number[][], passNo?: number) => {
    const im = image(); const c = canvas();
    if (!im || !c) return;
    try {
      const ann = await projectsApi.createAnnotation(c.projectId, {
        imageId: im.imageId, annotator: annotator(), kind, points, passNo,
        label: selClass(), viewport: clampRect(vb(), im.width, im.height),
      });
      pushAnnotation(ann);
    } catch (ex) {
      // most common: "must intersect at least one tile"
      alert(ex instanceof Error ? ex.message : 'Save failed');
    }
  };

  const interaction = createCanvasInteraction({
    getSvg: () => svgRef, vb, setVb, tool, draft, setDraft,
    commit: (kind, points, passNo) => void commit(kind, points, passNo),
  });

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter') interaction.finishDraft();
    if (e.key === 'Escape') setDraft([]);
  };
  onMount(() => window.addEventListener('keydown', onKey));
  onCleanup(() => window.removeEventListener('keydown', onKey));

  const pushAnnotation = (ann: CanvasAnnotation) => {
    setCanvas((c) => c && ({
      ...c,
      images: c.images.map((im, i) => i === imgIdx() ? { ...im, annotations: [...im.annotations, ann] } : im),
    }));
  };

  const deleteSelected = async () => {
    const id = selAnn();
    if (!id) return;
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

  // Class picker options come from the batch payload (project.classes), falling back
  // to a sensible default set plus the current selection if the project has none.
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
      <div class={styles.toolbar} data-testid="canvas-toolbar">
        <button class={styles.back} onClick={() => nav(-1)}>{t('canvas.back')}</button>
        <span class={styles.who}>{t('canvas.as')} <strong>{annotator()}</strong></span>
        <span class={styles.sep} />
        <For each={['pan', 'brush'] as Tool[]}>
          {(tl) => (
            <button class={tool() === tl ? styles.toolActive : styles.tool}
              onClick={() => { setTool(tl); setDraft([]); }}>{tl}</button>
          )}
        </For>
        <span class={styles.sep} />
        <label class={styles.classPick}>{t('canvas.class')}
          <select onChange={(e) => setSelClass(e.currentTarget.value)} value={selClass()}>
            <For each={classOptions()}>{(c) => <option value={c}>{c}</option>}</For>
          </select>
        </label>
        <button class={styles.tool} onClick={fitImage}>{t('canvas.fit')}</button>
        <Show when={selAnn()}>
          <button class={styles.danger} onClick={() => void deleteSelected()}>{t('canvas.deleteShape')}</button>
        </Show>
        <Show when={(canvas()?.images.length ?? 0) > 1}>
          <span class={styles.sep} />
          <button class={styles.tool} disabled={imgIdx() === 0} onClick={() => setImgIdx((i) => i - 1)}>{t('canvas.imgPrev')}</button>
          <span class={styles.who}>{imgIdx() + 1}/{canvas()!.images.length}</span>
          <button class={styles.tool} disabled={imgIdx() >= (canvas()!.images.length - 1)}
            onClick={() => setImgIdx((i) => i + 1)}>{t('canvas.imgNext')}</button>
        </Show>
      </div>

      <Show when={image()} fallback={<div class={styles.stage}>{t('common.loading')}</div>}>
        {(im) => (
          <div class={styles.stage} style={{ 'aspect-ratio': `${im().width} / ${im().height}` }}>
            <svg ref={svgRef} class={styles.svg}
              viewBox={`${vb().x} ${vb().y} ${vb().w} ${vb().h}`}
              preserveAspectRatio="xMidYMid meet"
              onWheel={interaction.onWheel}
              onPointerDown={interaction.onPointerDown}
              onPointerMove={interaction.onPointerMove}
              onPointerUp={interaction.onPointerUp}
              classList={{ [styles.panning]: tool() === 'pan' }}
            >
              <image href={imageUrls.overview(im().imageId)} x="0" y="0"
                width={im().width} height={im().height} />

              {/* tiles */}
              <For each={im().tiles}>
                {(tile) => (
                  <g>
                    <rect x={tile.x} y={tile.y} width={tile.w} height={tile.h}
                      fill="none" stroke={TILE_COLORS[tile.state ?? 'assigned']}
                      stroke-width="2" vector-effect="non-scaling-stroke"
                      stroke-dasharray={tile.state === 'completed' ? undefined : '6 4'} />
                    <circle class={styles.check} cx={tile.x + tile.w} cy={tile.y} r="8"
                      fill={tile.state === 'completed' ? '#16a34a' : '#fff'}
                      stroke="#16a34a" stroke-width="1.5" vector-effect="non-scaling-stroke"
                      onPointerDown={(e) => { e.stopPropagation(); void toggleTile(tile); }} />
                  </g>
                )}
              </For>

              {/* committed annotations */}
              <For each={im().annotations}>
                {(a) => <AnnotationShape ann={a} selected={selAnn() === a.id}
                  onSelect={() => setSelAnn(a.id)} />}
              </For>

              {/* draft */}
              <Show when={draft().length > 0}>
                <polyline points={draft().map((p) => p.join(',')).join(' ')}
                  fill="rgba(37,99,235,0.15)" stroke="#2563eb" stroke-width="2"
                  vector-effect="non-scaling-stroke" />
                <For each={draft()}>
                  {(p) => <circle cx={p[0]} cy={p[1]} r="3" fill="#2563eb" vector-effect="non-scaling-stroke" />}
                </For>
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
