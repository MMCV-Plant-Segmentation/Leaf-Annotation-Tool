import { style } from '@vanilla-extract/css';

/** a11y #40 v1b: draggable vertex handle. Cursor matches the tiling-edit checkmarks
 * (see `.check` in CanvasScreen.css.ts) so the grab affordance is consistent. */
export const handle = style({
  cursor: 'pointer',
});
