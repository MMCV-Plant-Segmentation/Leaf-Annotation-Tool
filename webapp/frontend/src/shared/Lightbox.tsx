/**
 * Minimal, project-agnostic image lightbox built on Kobalte Dialog (Escape / overlay
 * close, focus trap). Shows a large image plus an optional caption (e.g. a source path).
 * Reuse candidate — used by both the images grid and the tiling preview.
 */
import { type Component, type JSX, Show } from 'solid-js';
import {
  Root as DialogRoot, Portal as DialogPortal, Overlay as DialogOverlay,
  Content as DialogContent, CloseButton as DialogClose,
} from '@kobalte/core/dialog';
import { t } from '../i18n/catalog';
import * as styles from './Lightbox.css';

type Props = {
  open: boolean;
  src: string;
  caption?: string;
  alt?: string;
  /** Optional overlay (e.g. a tile SVG) drawn on top of, and aligned to, the image. */
  overlay?: JSX.Element;
  onImageClick?: () => void;
  onClose: () => void;
};

const Lightbox: Component<Props> = (props) => (
  <DialogRoot open={props.open} onOpenChange={(o) => { if (!o) props.onClose(); }} modal>
    <DialogPortal>
      <DialogOverlay class={styles.overlay} />
      <div class={styles.positioner}>
        <DialogContent class={styles.content} data-testid="lightbox">
          <DialogClose class={styles.closeBtn} aria-label={t('common.cancel')}>×</DialogClose>
          <div class={styles.frame}>
            <img class={styles.image} src={props.src} alt={props.alt ?? ''}
              data-testid="lightbox-image" onClick={() => props.onImageClick?.()} />
            <Show when={props.overlay}>
              <div class={styles.overlaySlot}>{props.overlay}</div>
            </Show>
          </div>
          <Show when={props.caption}>
            <div class={styles.caption} data-testid="lightbox-caption">{props.caption}</div>
          </Show>
        </DialogContent>
      </div>
    </DialogPortal>
  </DialogRoot>
);

export default Lightbox;
