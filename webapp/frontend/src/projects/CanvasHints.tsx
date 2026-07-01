import { type Component } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { ViewBox } from './canvasShapes';
import { t } from '../i18n/catalog';
import * as styles from './CanvasHints.css';

type Props = {
  vb: Accessor<ViewBox>;
};

// Usage hints + live viewport (x/y/w/h) readout, extracted from CanvasScreen to
// keep the parent under the 200-line file limit. Passive readout, no interaction.
export const CanvasHints: Component<Props> = (props) => (
  <div class={styles.row}>
    <div class={styles.help}>{t('canvas.help')}</div>
    <div class={styles.readout} data-testid="canvas-viewport-readout">
      {t('canvas.viewport', {
        x: Math.round(props.vb().x),
        y: Math.round(props.vb().y),
        w: Math.round(props.vb().w),
        h: Math.round(props.vb().h),
      })}
    </div>
  </div>
);
