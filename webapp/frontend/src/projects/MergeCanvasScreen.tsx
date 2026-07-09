/**
 * MERGE Phase 1: the read-only blind pooled viewer. Fetches the batch's tiles/images
 * (no per-annotator data) plus every non-deleted annotation from EVERY annotator that
 * intersects the batch, and renders them ALL identically — one colour, outline-only —
 * so a merger can't tell whose mark is whose. Shares CanvasScreen's stage (CanvasStage)
 * and toolbar (CanvasToolbar) — see those for the ONE shared nav model (whole image,
 * tiles overlaid, navigate IMAGE-by-image) both screens now use; merge just enables the
 * `pan` tool only (Phase 1 — no grouping/erase/select-CO tools yet) and renders in blind
 * mode. Grouping/agreement/conflict threads are later phases; this screen is just the
 * pooled view.
 */
import { type Component, createEffect, createMemo, createResource, createSignal, on } from 'solid-js';
import { useNavigate, useParams } from '@solidjs/router';
import { projectsApi, type CanvasImage } from './api';
import { t } from '../i18n/catalog';
import { type Tool, type ViewBox } from './canvasShapes';
import { createCanvasInteraction } from './canvasInteraction';
import { createImageDecodeGate } from './imageDecodeGate';
import { CanvasToolbar } from './CanvasToolbar';
import { CanvasStage } from './CanvasStage';
import * as styles from './CanvasScreen.css';
import * as mstyles from './MergeCanvasScreen.css';

// Every pooled mark renders in this ONE colour regardless of who drew it — the whole
// point of blind merge mode. Data-viz colour, so it's inline here per FE convention
// rather than a theme token (it isn't chrome, it's the anonymised mark paint).
const BLIND_COLOR = '#0ea5e9';

// Merge Phase 1 tools = PAN ONLY (see canvasToolRegistry.ts for the shared registry;
// grouping/erase/select-CO tools are a later phase, out of scope here).
const MERGE_TOOLS: Tool[] = ['pan'];
const pan = (): Tool => 'pan';

const MergeCanvasScreen: Component = () => {
  const params = useParams();
  const nav = useNavigate();
  const batchId = () => params.batchId;

  const [batch] = createResource(batchId, (id: string) => projectsApi.mergeBatch(id));
  const [pooled] = createResource(batchId, (id: string) => projectsApi.mergeAnnotations(id));

  const [imgIdx, setImgIdx] = createSignal(0);
  const currentImage = createMemo<CanvasImage | undefined>(() => batch()?.images[imgIdx()]);

  const imageId = createMemo(() => currentImage()?.imageId);
  const imgLoaded = createImageDecodeGate(imageId);

  const [vb, setVb] = createSignal<ViewBox>({ x: 0, y: 0, w: 100, h: 100 });
  let svgRef: SVGSVGElement | undefined;

  const fitImage = () => { const im = currentImage(); if (im) setVb({ x: 0, y: 0, w: im.width, h: im.height }); };
  createEffect(on(imageId, () => { if (currentImage()) fitImage(); }));

  // Read-only: pan/zoom only. `tool` is pinned to 'pan' and `commit` is a no-op, so
  // there's no path to a write even though createCanvasInteraction is shared plumbing.
  const [draft, setDraft] = createSignal<number[][]>([]);
  const interaction = createCanvasInteraction({
    getSvg: () => svgRef, vb, setVb, tool: pan, draft, setDraft,
    brushSize: () => 0, setBrushSize: () => {}, maxBrushSize: () => 1,
    commit: () => {},
  });

  const annotationsForImage = createMemo(() => {
    const im = currentImage();
    if (!im) return [];
    return (pooled()?.annotations ?? []).filter((a) => a.imageId === im.imageId);
  });

  return (
    <div class={styles.wrap} data-screen="merge-canvas">
      <CanvasToolbar
        tools={MERGE_TOOLS}
        tool={pan} setTool={() => {}}
        wrapTestId="merge-toolbar"
        badge={<span class={mstyles.blindBadge} data-testid="merge-blind-badge">{t('mergeCanvas.blindLabel')}</span>}
        imgIdx={imgIdx} imgCount={batch()?.images.length ?? 0}
        onBack={() => nav(-1)} onFit={fitImage}
        onImgPrev={() => setImgIdx((i) => i - 1)} onImgNext={() => setImgIdx((i) => i + 1)}
      />

      <CanvasStage
        setSvgRef={(el) => { svgRef = el; }}
        vb={vb} image={currentImage} imgLoaded={imgLoaded} tool={pan} interaction={interaction}
        annotations={annotationsForImage()}
        annotationColor={() => BLIND_COLOR}
        blind
      />
    </div>
  );
};

export default MergeCanvasScreen;
