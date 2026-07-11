import type { Tool } from './canvasShapes';
import { t } from '../i18n/catalog';

export type ToolMeta = { label: string; title: string; testId: string };

/**
 * tool → {label, title, testid} registry for CanvasToolbar's tool buttons. Keeps the
 * toolbar TOOLS-LIST-DRIVEN: a caller enables a subset (`tools: Tool[]` prop) instead of
 * the toolbar hardcoding which tools exist — annotate enables
 * ['select','pan','brush','eraser'], merge enables only ['pan'] (see MergeCanvasScreen).
 *
 * Only tools actually offered by either toolbar have entries here; 'polygon'/'line' are
 * legacy commit paths reachable via canvasInteraction's draft/finishDraft but never wired
 * to a toolbar button (see canvasInteraction.ts's onPointerDown comment), so they fall
 * through to the generic default below rather than getting a real registry entry.
 *
 * `t()` is called per-lookup (not memoized at module scope) so the catalog swap on
 * locale load is picked up — this module has no top-level `t()` calls.
 */
export function toolMeta(tl: Tool): ToolMeta {
  switch (tl) {
    case 'select':
      return { label: t('canvas.select'), title: t('canvas.select'), testId: 'tool-select' };
    case 'pan':
      return { label: t('canvas.pan'), title: t('canvas.panTitle'), testId: 'tool-pan' };
    case 'brush':
      return { label: t('canvas.brush'), title: t('canvas.brushTitle'), testId: 'tool-brush' };
    case 'polyline':
      return { label: t('canvas.polyline'), title: t('canvas.polylineTitle'), testId: 'tool-polyline' };
    case 'eraser':
      return { label: t('canvas.eraser'), title: t('canvas.eraserTitle'), testId: 'tool-eraser' };
    case 'group':
      return { label: t('canvas.group'), title: t('canvas.groupTitle'), testId: 'tool-group' };
    default:
      return { label: tl, title: tl, testId: `tool-${tl}` };
  }
}
