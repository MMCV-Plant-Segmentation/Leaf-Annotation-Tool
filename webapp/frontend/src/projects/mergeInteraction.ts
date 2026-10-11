/**
 * MERGE Phase 2a: a thin wrapper around createCanvasInteraction that alters ONE thing
 * — the meaning of the `eraser` tool. In annotate mode `eraser` is a BRUSH DRAG (drag
 * across strokes to delete them); in merge mode `eraser` is a CLICK on a pooled mark
 * to toggle its recoverable erasure. So we ALIAS the merge tool → the base tool with
 *   eraser → select   (routes via `onSelect(imgPoint)` — the caller dispatches).
 * `group` stays 'group' at the base level (canvasInteraction handles it as a stroke-
 * brush tool alongside 'brush'), and 'pan'/'select' pass through unchanged.
 *
 * The rest of the interaction (wheel zoom, space-pan, pinch-zoom, brush-size scroll)
 * is unchanged — merge inherits it as-is. Kept in its own file so MergeCanvasScreen
 * stays ≤200 lines.
 */
import type { Accessor } from 'solid-js';
import type { Tool } from './canvasShapes';
import { createCanvasInteraction, type CanvasInteraction, type CanvasInteractionOpts } from './canvasInteraction';

export function createMergeInteraction(opts: CanvasInteractionOpts): CanvasInteraction {
  const originalTool = opts.tool;
  const baseTool: Accessor<Tool> = () => {
    const tl = originalTool();
    return tl === 'eraser' ? 'select' : tl;
  };
  return createCanvasInteraction({ ...opts, tool: baseTool });
}
