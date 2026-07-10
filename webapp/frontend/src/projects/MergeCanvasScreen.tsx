/**
 * MERGE Phase 2a: the shared canvas viewer wired for grouping brush + eraser + select.
 * Phase 1 was read-only (pooled blind view, `pan` only); 2a grows the toolset to
 * ['pan','group','select','eraser'] and wires each to the 2a backends:
 *  - `group` (drag) → POST /api/batches/<id>/candidate-objects (backend resolves member
 *    marks via shapely from the raw brush path — client never re-derives membership).
 *  - `eraser` (click a mark) → POST/DELETE /api/batches/<id>/erasures (recoverable
 *    toggle, per-merger, survives reload — it's a co_erasure row).
 *  - `select` (click a mark or CO hull) → tracks a selection for the action bar's
 *    Group/Ungroup/Dissolve buttons (backing PATCH/DELETE endpoints).
 *
 * The pooled MARKS stay BLIND (one colour, outline-only) — 2a doesn't de-blind them.
 * A CO is the merger's OWN work (not blinded), so it renders in its own amber paint
 * as a soft brush-stroke along the convex hull of its members (CandidateObjectLayer).
 * The mutation plumbing lives in mergeMutations.ts (keeps this file ≤200 lines).
 */
import { type Component, createEffect, createMemo, createResource, createSignal, on, Show } from 'solid-js';
import { useNavigate, useParams } from '@solidjs/router';
import { projectsApi, type CanvasImage, type CanvasAnnotation } from './api';
import { currentUser } from '../auth';
import { t } from '../i18n/catalog';
import { type Tool, type ViewBox } from './canvasShapes';
import { createMergeInteraction } from './mergeInteraction';
import { createImageDecodeGate } from './imageDecodeGate';
import { hitTestAnnotation, pointInPolygon } from './lesionSelect';
import { CanvasToolbar } from './CanvasToolbar';
import { CanvasStage } from './CanvasStage';
import { CandidateObjectLayer, coHullPoints } from './CandidateObjectLayer';
import { createMergeMutations } from './mergeMutations';
import * as styles from './CanvasScreen.css';
import * as mstyles from './MergeCanvasScreen.css';

// Blind data-viz colour for every pooled mark (see AnnotationShape's `blind` prop) —
// inline per FE convention (data-viz colour, not chrome).
const BLIND_COLOR = '#0ea5e9';

// Merge Phase 2a toolset — CanvasToolbar renders these via canvasToolRegistry.toolMeta,
// producing testids `tool-pan`/`tool-group`/`tool-select`/`tool-eraser` for the e2e.
const MERGE_TOOLS: Tool[] = ['pan', 'group', 'select', 'eraser'];

// Default grouping-brush width (image px) — wide enough to catch nearby marks with one
// pass. Scroll-wheel resize wires through createCanvasInteraction just like the annotate
// brush (the merge toolbar doesn't render the slider today).
const DEFAULT_BRUSH = 60;

const MergeCanvasScreen: Component = () => {
  const params = useParams();
  const nav = useNavigate();
  const batchId = () => params.batchId;
  const merger = () => currentUser()?.username ?? '';

  const [batch] = createResource(batchId, (id: string) => projectsApi.mergeBatch(id));
  const [pooled] = createResource(batchId, (id: string) => projectsApi.mergeAnnotations(id));

  // Per-merger CO + erasure resources (keyed on (batchId, merger) so a login switch or
  // route change refetches). A page reload re-runs createResource → the erased-mark
  // flag reappears from co_erasure (the "persistence across reload" part of the spec).
  const coKey = createMemo(() => {
    const b = batchId(), m = merger();
    return (b && m) ? `${b}|${m}` : undefined;
  });
  const parseKey = (k: string) => { const s = k.indexOf('|'); return [k.slice(0, s), k.slice(s + 1)] as const; };
  const [cos, { mutate: setCos }] = createResource(coKey,
    (k: string) => { const [b, m] = parseKey(k); return projectsApi.listCandidateObjects(b, m); });
  const [erasures, { mutate: setErasures }] = createResource(coKey,
    (k: string) => { const [b, m] = parseKey(k); return projectsApi.listErasures(b, m); });
  const erasedSet = createMemo(() => new Set(erasures()?.erasedIds ?? []));
  const isErased = (ann: CanvasAnnotation) => erasedSet().has(ann.id);

  const [imgIdx, setImgIdx] = createSignal(0);
  const currentImage = createMemo<CanvasImage | undefined>(() => batch()?.images[imgIdx()]);
  const imageId = createMemo(() => currentImage()?.imageId);
  const imgLoaded = createImageDecodeGate(imageId);

  const [tool, setTool] = createSignal<Tool>('pan');
  const [vb, setVb] = createSignal<ViewBox>({ x: 0, y: 0, w: 100, h: 100 });
  const [draft, setDraft] = createSignal<number[][]>([]);
  const [brushSize, setBrushSize] = createSignal(DEFAULT_BRUSH);
  const [selectedMarkId, setSelectedMarkId] = createSignal<string | null>(null);
  const [selectedCoId, setSelectedCoId] = createSignal<string | null>(null);
  let svgRef: SVGSVGElement | undefined;

  const fitImage = () => { const im = currentImage(); if (im) setVb({ x: 0, y: 0, w: im.width, h: im.height }); };
  createEffect(on(imageId, () => {
    if (currentImage()) fitImage();
    setSelectedMarkId(null); setSelectedCoId(null);
  }));

  const annotationsForImage = createMemo(() => {
    const im = currentImage(); if (!im) return [] as CanvasAnnotation[];
    return (pooled()?.annotations ?? []).filter((a) => a.imageId === im.imageId);
  });
  const cosForImage = createMemo(() => {
    const im = currentImage(); if (!im) return [];
    return (cos()?.candidateObjects ?? []).filter((c) => c.imageId === im.imageId);
  });

  const maxBrushSize = createMemo(() => {
    const im = currentImage();
    return im ? Math.round(Math.hypot(im.width, im.height)) : 1000;
  });

  const mutations = createMergeMutations({
    batchId, imageId, brushSize,
    getCos: () => cos(), getErasures: () => erasures(),
    setCos: (v) => setCos(v), setErasures: (v) => setErasures(v),
  });

  // The interaction's `commit(kind, points, _, width)` fires for kind='group' after a
  // brush-drag (see canvasInteraction.ts). We ignore other kinds (merge doesn't paint).
  const onCommit = (kind: string, points: number[][]) => {
    if (kind === 'group') void mutations.createGroup(points);
  };

  // Click hit-test for eraser / select tools. Eraser toggles the mark's erasure;
  // select records the mark (or a CO whose hull covers the click) for the action bar.
  const onHit = (pt: [number, number]) => {
    const anns = annotationsForImage();
    const markId = hitTestAnnotation(anns, pt[0], pt[1]);
    const tl = tool();
    if (tl === 'eraser') {
      if (markId) void mutations.toggleErasure(markId);
      return;
    }
    if (tl === 'select') {
      if (markId) { setSelectedMarkId(markId); setSelectedCoId(null); return; }
      const co = cosForImage().find((c) => {
        const hull = coHullPoints(c, anns);
        return hull.length >= 3 && pointInPolygon(pt[0], pt[1], hull);
      });
      setSelectedMarkId(null);
      setSelectedCoId(co?.id ?? null);
    }
  };

  const interaction = createMergeInteraction({
    getSvg: () => svgRef, vb, setVb, tool,
    draft, setDraft, brushSize, setBrushSize, maxBrushSize,
    commit: onCommit, onSelect: onHit,
  });

  return (
    <div class={styles.wrap} data-screen="merge-canvas">
      <CanvasToolbar
        tools={MERGE_TOOLS}
        tool={tool} setTool={(tl) => { setTool(tl); setDraft([]); }}
        wrapTestId="merge-toolbar"
        badge={<span class={mstyles.blindBadge} data-testid="merge-blind-badge">{t('mergeCanvas.blindLabel')}</span>}
        imgIdx={imgIdx} imgCount={batch()?.images.length ?? 0}
        onBack={() => nav(-1)} onFit={fitImage}
        onImgPrev={() => setImgIdx((i) => i - 1)} onImgNext={() => setImgIdx((i) => i + 1)}
      />

      <Show when={selectedMarkId() || selectedCoId()}>
        <div class={mstyles.actionBar} data-testid="merge-action-bar">
          <Show when={selectedMarkId()}>
            {(mid) => (
              <button class={styles.tool} data-testid="merge-ungroup-btn"
                onClick={() => { void mutations.ungroupMark(mid()); setSelectedMarkId(null); }}>
                {t('mergeCanvas.ungroup')}
              </button>
            )}
          </Show>
          <Show when={selectedCoId()}>
            {(cid) => (
              <button class={styles.tool} data-testid="merge-dissolve-btn"
                onClick={() => { void mutations.dissolveCo(cid()); setSelectedCoId(null); }}>
                {t('mergeCanvas.dissolve')}
              </button>
            )}
          </Show>
        </div>
      </Show>

      <CanvasStage
        setSvgRef={(el) => { svgRef = el; }}
        vb={vb} image={currentImage} imgLoaded={imgLoaded} tool={tool} interaction={interaction}
        annotations={annotationsForImage()}
        annotationColor={() => BLIND_COLOR}
        annotationErased={isErased}
        blind
      >
        <CandidateObjectLayer cos={cosForImage()} annotations={annotationsForImage()} />
      </CanvasStage>
    </div>
  );
};

export default MergeCanvasScreen;
