/**
 * Reusable zoom/pan viewport. Wheel / trackpad-pinch zooms around the cursor;
 * drag pans; bounded so content cannot be lost off-screen. Content renders at
 * naturalWidth × naturalHeight inside a scaled canvas so a tile SVG overlay
 * stays pixel-aligned at every zoom/pan level. A "Fit" button resets the view
 * and calls onReset (lets the parent deselect a selected tile).
 *
 * Reuse candidate — note in someday-library doc.
 */
import { createEffect, createSignal, onCleanup, onMount, type Component, type JSX } from 'solid-js';
import type { Rect } from '../projects/api';
import * as styles from './ZoomPanViewport.css';

type Xform = { tx: number; ty: number; scale: number };

type Props = {
  naturalWidth: number;
  naturalHeight: number;
  /** When set, viewport zooms/centres on this rect. Null = reset to fit. */
  zoomTarget?: Rect | null;
  /** Called when the Fit/reset button is clicked (lets parent deselect a tile). */
  onReset?: () => void;
  children: JSX.Element;
};

const MIN_SCALE = 0.04;
const MAX_SCALE = 30;

const ZoomPanViewport: Component<Props> = (props) => {
  let containerRef!: HTMLDivElement;
  const [xform, setXform] = createSignal<Xform>({ tx: 0, ty: 0, scale: 1 });

  // Pointer drag state — plain vars, not signals (no re-render needed).
  let startX = 0, startY = 0, prevX = 0, prevY = 0, didDrag = false;

  const containerSize = () => ({
    cw: containerRef?.offsetWidth ?? 800,
    ch: containerRef?.offsetHeight ?? 600,
  });

  const fitXform = (): Xform => {
    const { cw, ch } = containerSize();
    const scale = Math.min(cw / props.naturalWidth, ch / props.naturalHeight);
    return {
      tx: (cw - props.naturalWidth * scale) / 2,
      ty: (ch - props.naturalHeight * scale) / 2,
      scale,
    };
  };

  const clamp = ({ tx, ty, scale }: Xform): Xform => {
    const { cw, ch } = containerSize();
    const bx = Math.min(60, cw * 0.12);
    const by = Math.min(60, ch * 0.12);
    return {
      tx: Math.max(bx - props.naturalWidth * scale, Math.min(cw - bx, tx)),
      ty: Math.max(by - props.naturalHeight * scale, Math.min(ch - by, ty)),
      scale,
    };
  };

  onMount(() => setXform(fitXform()));

  // Zoom/centre on a target tile; null → reset to fit.
  createEffect(() => {
    const tgt = props.zoomTarget;
    if (!containerRef) return;
    if (!tgt) { setXform(fitXform()); return; }
    const { cw, ch } = containerSize();
    const scale = Math.min(
      (cw / (tgt.w || 1)) * 0.75,
      (ch / (tgt.h || 1)) * 0.75,
      MAX_SCALE,
    );
    const tx = cw / 2 - (tgt.x + tgt.w / 2) * scale;
    const ty = ch / 2 - (tgt.y + tgt.h / 2) * scale;
    setXform(clamp({ tx, ty, scale }));
  });

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const rect = containerRef.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
    const cur = xform();
    const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, cur.scale * factor));
    const ratio = scale / cur.scale;
    setXform(clamp({ tx: cx - (cx - cur.tx) * ratio, ty: cy - (cy - cur.ty) * ratio, scale }));
  };

  const onMove = (e: PointerEvent) => {
    const dx = e.clientX - prevX; const dy = e.clientY - prevY;
    prevX = e.clientX; prevY = e.clientY;
    if (!didDrag) {
      const d = (e.clientX - startX) ** 2 + (e.clientY - startY) ** 2;
      if (d < 25) return;
      didDrag = true;
    }
    setXform((c) => clamp({ ...c, tx: c.tx + dx, ty: c.ty + dy }));
  };

  const onUp = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
  };

  onCleanup(onUp);

  const onPointerDown = (e: PointerEvent) => {
    startX = prevX = e.clientX; startY = prevY = e.clientY; didDrag = false;
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };

  const handleReset = () => { setXform(fitXform()); props.onReset?.(); };

  return (
    <div ref={containerRef} class={styles.container} onWheel={onWheel} onPointerDown={onPointerDown}>
      <div class={styles.canvas} data-testid="zoom-pan-canvas"
        style={{
          transform: `translate(${xform().tx}px,${xform().ty}px) scale(${xform().scale})`,
          'transform-origin': '0 0',
          width: `${props.naturalWidth}px`,
          height: `${props.naturalHeight}px`,
          position: 'absolute',
        }}>
        {props.children}
      </div>
      <button class={styles.resetBtn} onClick={handleReset} aria-label="Reset zoom to fit">⊡</button>
    </div>
  );
};

export default ZoomPanViewport;
