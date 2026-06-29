/**
 * Project-agnostic image lightbox (Kobalte Dialog). Provides interactive zoom/pan
 * via ZoomPanViewport when natural image dimensions are known (passed as props or
 * measured from img onLoad). An optional overlay (e.g. a tile SVG) transforms
 * with the image inside the viewport for pixel-perfect alignment at any zoom level.
 * Escape / backdrop click closes. Reuse candidate — used by images grid + tiling preview.
 */
import { type Component, type JSX, createSignal, Show } from 'solid-js';
import {
  Root as DialogRoot, Portal as DialogPortal, Overlay as DialogOverlay,
  Content as DialogContent, CloseButton as DialogClose,
} from '@kobalte/core/dialog';
import { t } from '../i18n/catalog';
import ZoomPanViewport from './ZoomPanViewport';
import type { Rect } from '../projects/api';
import * as styles from './Lightbox.css';

type Props = {
  open: boolean;
  src: string;
  caption?: string;
  alt?: string;
  /** Provide when known up-front (e.g. from TilePreviewData). Otherwise auto-measured. */
  naturalWidth?: number;
  naturalHeight?: number;
  /** Optional content (e.g. tile SVG) rendered inside the viewport canvas. */
  overlay?: JSX.Element;
  /** When set, viewport zooms/centres on this rect. Null = reset to fit. */
  zoomTarget?: Rect | null;
  /** Called when the viewport's fit-reset button is clicked. */
  onZoomReset?: () => void;
  onClose: () => void;
};

const Lightbox: Component<Props> = (props) => {
  const [measuredW, setMeasuredW] = createSignal(0);
  const [measuredH, setMeasuredH] = createSignal(0);

  const natW = () => props.naturalWidth ?? measuredW();
  const natH = () => props.naturalHeight ?? measuredH();
  const hasNat = () => natW() > 0 && natH() > 0;

  const onLoad = (e: Event) => {
    const img = e.currentTarget as HTMLImageElement;
    if (!props.naturalWidth)  setMeasuredW(img.naturalWidth);
    if (!props.naturalHeight) setMeasuredH(img.naturalHeight);
  };

  return (
    <DialogRoot open={props.open} onOpenChange={(o) => { if (!o) props.onClose(); }} modal>
      <DialogPortal>
        <DialogOverlay class={styles.overlay} />
        <div class={styles.positioner}>
          <DialogContent class={styles.content} data-testid="lightbox">
            <DialogClose class={styles.closeBtn} aria-label={t('common.cancel')}>×</DialogClose>
            <Show when={hasNat()} fallback={
              <img class={styles.image} src={props.src} alt={props.alt ?? ''}
                data-testid="lightbox-image" onLoad={onLoad} />
            }>
              <div class={styles.viewportWrap}>
                <ZoomPanViewport naturalWidth={natW()} naturalHeight={natH()}
                  zoomTarget={props.zoomTarget} onReset={props.onZoomReset}>
                  <img class={styles.viewportImage} src={props.src} alt={props.alt ?? ''}
                    data-testid="lightbox-image" onLoad={onLoad} />
                  <Show when={props.overlay}>
                    <div class={styles.overlaySlot}>{props.overlay}</div>
                  </Show>
                </ZoomPanViewport>
              </div>
            </Show>
            <Show when={props.caption}>
              <div class={styles.caption} data-testid="lightbox-caption">{props.caption}</div>
            </Show>
          </DialogContent>
        </div>
      </DialogPortal>
    </DialogRoot>
  );
};

export default Lightbox;
