import { createMemo } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { CanvasImage } from './api';

/**
 * Compound labels Phase 2b: the paint drop-down's dual role as a relabel picker.
 * - DISPLAY: shows the selected lesion's current label when one is selected (auto-sync,
 *   #2); otherwise the remembered "active brush" paint label (restore-on-deselect, #3).
 * - PICK: choosing a value while a lesion is selected re-labels THAT lesion (#1) instead
 *   of touching the remembered paint label; picking with nothing selected updates the
 *   remembered paint label, same as pre-2b behaviour.
 *
 * Split out of CanvasScreen.tsx to keep it under the file's line limit.
 */
export function createRelabelDropdown(o: {
  selId: Accessor<string | null>;
  image: Accessor<CanvasImage | undefined>;
  paintLabel: Accessor<string>;
  setPaintLabel: (label: string) => void;
  relabel: (annotationId: string, label: string) => void | Promise<void>;
}) {
  const dropdownLabel = createMemo(() => {
    const id = o.selId();
    const sel = id ? o.image()?.annotations.find((a) => a.id === id) : undefined;
    return sel ? (sel.label ?? '') : o.paintLabel();
  });
  const pickDropdown = (label: string) => {
    const id = o.selId();
    if (id) void o.relabel(id, label);
    else o.setPaintLabel(label);
  };
  return { dropdownLabel, pickDropdown };
}
