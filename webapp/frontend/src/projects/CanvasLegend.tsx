/**
 * Canvas legend: the compounds present in the current image's annotations (taxonomy v2).
 *
 * Reads each annotation's denormalised snapshot colour (captured at assign time) so the
 * legend reflects what is actually painted — even compounds whose preset was since deleted
 * still appear here via their snapshot. Pure presentation; extracted to keep CanvasScreen
 * under 200 lines.
 */
import { type Component, For, Show, createMemo } from 'solid-js';
import type { CanvasAnnotation, Label } from './api';
import { t } from '../i18n/catalog';
import * as styles from './CanvasScreen.css';

type Props = {
  annotations: CanvasAnnotation[];
  classes: Label[];
};

/** A legend entry: a colour + the label name (from the snapshot, falling back to label text). */
type Entry = { name: string; color: string };

export const CanvasLegend: Component<Props> = (props) => {
  // The set of (name, colour) actually painted on this image, preserving snapshot colour.
  const entries = createMemo<Entry[]>(() => {
    const byName = new Map<string, Entry>();
    for (const a of props.annotations) {
      const name = a.labelSnapshot?.name ?? a.label ?? '';
      if (!name) continue;
      const color = a.labelSnapshot?.color
        ?? props.classes.find((c) => c.name === a.label)?.color
        ?? '#2563eb';
      if (!byName.has(name)) byName.set(name, { name, color });
    }
    return [...byName.values()];
  });

  return (
    <Show when={entries().length > 0}>
      <div class={styles.legend} data-testid="canvas-legend">
        <span class={styles.legendTitle}>{t('canvas.legend')}</span>
        <For each={entries()}>
          {(e) => (
            <span class={styles.legendItem}>
              <span class={styles.legendSwatch} style={{ background: e.color }} aria-hidden="true" />
              {e.name}
            </span>
          )}
        </For>
      </div>
    </Show>
  );
};

export default CanvasLegend;
