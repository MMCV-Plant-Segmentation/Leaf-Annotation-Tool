import { type Component, For } from 'solid-js';
import type { Accessor } from 'solid-js';
import { t } from '../i18n/catalog';
import * as styles from './CanvasScreen.css';

type Props = {
  roster: Accessor<string[]>;
  value: Accessor<string>;
  onChange: (byline: string) => void;
};

// Admin-only read-only-viewer picker (BUGS #15): choose which project annotator's
// annotations/lesions/tile-completion to view. One at a time — no multi-overlay
// (that's the separate, out-of-scope consensus feature).
export const AnnotatorPicker: Component<Props> = (props) => (
  <label class={styles.classPick} data-testid="annotator-picker">
    {t('canvas.viewing')}
    <select data-testid="annotator-select" value={props.value()}
      onChange={(e) => props.onChange(e.currentTarget.value)}>
      <For each={props.roster()}>{(b) => <option value={b}>{b}</option>}</For>
    </select>
  </label>
);
