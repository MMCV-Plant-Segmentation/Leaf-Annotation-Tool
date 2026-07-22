// t109: build the annotator paint dropdown's option list — the valid compound palette
// PLUS broken (INVALID) compounds folded in, flagged (`broken: true`) so the user sees
// they need fixing in the labels editor, but still paintable (resolution matches by
// name against the full compound list, valid or invalid).
import type { Label } from './api';
import type { BrokenCompound } from './taxonomy';

export const buildClassOptions = (valid: Label[], broken: BrokenCompound[]): Label[] => [
  ...valid,
  ...broken.map((b, i) => ({
    id: b.id, name: b.name, color: b.color, order: valid.length + i, broken: true,
  })),
];
