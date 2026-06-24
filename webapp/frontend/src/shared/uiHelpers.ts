import type uiStyles from './ui.module.css';

type UiModule = typeof uiStyles;

export function setKindClass(ui: UiModule, kind: string): string {
  const map: Record<string, string> = {
    raw:         ui.setKindRaw,
    merged:      ui.setKindMerged,
    reannotated: ui.setKindReannotated,
    terminal:    ui.setKindTerminal,
  };
  return map[kind] ?? '';
}
