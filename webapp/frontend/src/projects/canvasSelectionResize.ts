/**
 * t65: resize the SELECTED stroke mask by scrolling over it (Select tool). Scrolling scales
 * the selected annotation's stroke width RELATIVELY (×1.15 per notch), scaling every member
 * stroke's per-vertex sizes + width and routing each through `editStroke` (which recomputes
 * the outline + re-fuses the scope, exactly like a vertex edit). Kept in its own module so
 * CanvasScreen stays under the 200-line cap. The absolute-size control is separate.
 */
import type { CanvasAnnotation } from './canvasApi';
import { scaleStrokeSizes, setStrokeSizes } from './canvasVertexEdit';

const STEP = 1.15;

export interface SelectionResizeDeps {
  /** The currently-selected annotation (or undefined). */
  selected: () => CanvasAnnotation | undefined;
  /** Re-issue a member stroke with new points + width (canvasPersistence.editStroke). */
  editStroke: (strokeId: string, tool: string, points: number[][], strokeWidth: number) => void;
}

/**
 * Returns a scroll handler `(dir) => handled`: scales the selected mask by one notch (dir=1
 * grow, dir=-1 shrink) and returns true, or returns false when nothing is selected (so the
 * caller falls back to panning). Scales EVERY member stroke so a fused multi-stroke mask
 * resizes as a whole.
 */
export function makeResizeSelected(deps: SelectionResizeDeps): (dir: 1 | -1) => boolean {
  return (dir) => {
    const ann = deps.selected();
    if (!ann?.strokes?.length) return false;
    const factor = dir > 0 ? STEP : 1 / STEP;
    for (const s of ann.strokes) {
      deps.editStroke(s.id, s.tool, scaleStrokeSizes(s.points, factor, s.strokeWidth),
                      Math.max(1, s.strokeWidth * factor));
    }
    return true;
  };
}

/** t65 (absolute): set the selected mask's stroke width to `size` (from the slider/number
 *  input or the presets dropdown), applied to every member stroke. */
export function makeSetSelectionSize(deps: SelectionResizeDeps): (size: number) => void {
  return (size) => {
    const ann = deps.selected();
    if (!ann?.strokes?.length) return;
    for (const s of ann.strokes) deps.editStroke(s.id, s.tool, setStrokeSizes(s.points, size), Math.max(1, size));
  };
}

/** The selected mask's representative stroke width (its first member stroke), or null when
 *  nothing is selected — drives whether/what the Select-tool size control shows (t65). */
export function selectionWidth(ann: CanvasAnnotation | undefined): number | null {
  return ann?.strokes?.[0]?.strokeWidth ?? null;
}

/** Bundle the three selection-resize handles from one deps object, so CanvasScreen wires
 *  them in a single line (it sits at the file-size cap). */
export function createSelectionResize(deps: SelectionResizeDeps) {
  return {
    resizeSelected: makeResizeSelected(deps),
    setSelectionSize: makeSetSelectionSize(deps),
    selectionSize: () => selectionWidth(deps.selected()),
  };
}
