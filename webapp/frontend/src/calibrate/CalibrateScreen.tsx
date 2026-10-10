/**
 * t157 — input calibration page (temporary, reached from the canvas toolbar). Draw on the pad and
 * it reports what this browser + device ACTUALLY delivers: pointer events vs coalesced samples,
 * real rates, double deliveries, and which of pressure/tilt/twist/altitude carry signal.
 *
 * The pad is wired TWICE on purpose: a direct `addEventListener` (the ground truth for what the
 * browser sends) and Solid's delegated `onPointerMove` (the path the annotator uses). If the
 * delegated count is double the direct count, the app duplicates; if the direct listener already
 * sees duplicates, the browser does.
 */
import { type Component, createSignal, onCleanup, onMount, For, Show } from 'solid-js';
import { t } from '../i18n/catalog';
import { summarize, type CalEvent, type CalSample, type CalStroke, type CalSummary } from './calibrateStats';
import { createRefreshMeter } from './refreshMeter';
import * as styles from './CalibrateScreen.css';

// Canvas ink (data-viz colour lives inline in .tsx, per the theme rule).
const INK_PATH = '#8a8f98';
const INK_SAMPLE = '#3fa7ff';
const INK_EVENT = '#ff6b3d';

const fmtRange = (r: [number, number]) => (r[0] === r[1] ? `${r[0]}` : `${r[0]} – ${r[1]}`);

function rows(s: CalSummary, refreshHz: number): [string, string][] {
  return [
    ['calibrate.refresh', `${refreshHz} Hz`],
    ['calibrate.pointerType', s.pointerType],
    ['calibrate.duration', `${s.durationMs} ms`],
    ['calibrate.moveEvents', `${s.moveEvents}`],
    ['calibrate.delegatedMoves', `${s.delegatedMoves}`],
    ['calibrate.duplicateMoves', `${s.duplicateMoves}`],
    ['calibrate.eventHz', `${s.eventHz} Hz`],
    ['calibrate.coalesced', `${s.coalescedTotal} (max ${s.coalescedMaxPerEvent}/event)`],
    ['calibrate.sampleHz', `${s.sampleHz} Hz`],
    ['calibrate.sampleDt', `${s.medianSampleDtMs} ms`],
    ['calibrate.predicted', `max ${s.predictedMaxPerEvent}/event`],
    ['calibrate.rawUpdates', `${s.rawUpdates}`],
    ['calibrate.subMs', `${Math.round(s.subMsTimestamps * 100)}%`],
    ['calibrate.pressure', fmtRange(s.pressure)],
    ['calibrate.tilt', `${fmtRange(s.tiltX)} / ${fmtRange(s.tiltY)}`],
    ['calibrate.twist', fmtRange(s.twist)],
    ['calibrate.altitude', s.altitudeReported ? t('calibrate.yes') : t('calibrate.no')],
  ];
}

const CalibrateScreen: Component = () => {
  let canvas!: HTMLCanvasElement;
  const refresh = createRefreshMeter();
  const [summary, setSummary] = createSignal<CalSummary | null>(null);
  // Every finished stroke, frozen at pointer-up (refresh rate captured then) — the report only
  // changes when a stroke ends, so selecting/copying it is never reset by a live readout.
  const [log, setLog] = createSignal<(CalSummary & { refreshHz: number })[]>([]);
  let cur: CalStroke | null = null;
  const api = {
    coalesced: typeof PointerEvent !== 'undefined' && 'getCoalescedEvents' in PointerEvent.prototype,
    predicted: typeof PointerEvent !== 'undefined' && 'getPredictedEvents' in PointerEvent.prototype,
    rawupdate: 'onpointerrawupdate' in window,
  };

  const pos = (e: PointerEvent): [number, number] => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const ctx = () => canvas.getContext('2d')!;
  const dot = (x: number, y: number, r: number, color: string) => {
    const c = ctx(); c.fillStyle = color; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
  };

  const record = (kind: CalEvent['kind'], e: PointerEvent) => {
    if (!cur) return;
    const co = kind === 'move' && api.coalesced ? e.getCoalescedEvents() : [];
    const pr = kind === 'move' && api.predicted ? e.getPredictedEvents() : [];
    const [x, y] = pos(e);
    const ext = e as PointerEvent & { altitudeAngle?: number; azimuthAngle?: number };
    cur.events.push({ kind, ts: e.timeStamp, x, y, coalesced: co.length, predicted: pr.length,
      pressure: e.pressure, tiltX: e.tiltX, tiltY: e.tiltY, twist: e.twist,
      altitude: ext.altitudeAngle ?? null, azimuth: ext.azimuthAngle ?? null, pointerType: e.pointerType });
    if (kind === 'raw') return;
    const subs: CalSample[] = (co.length ? co : [e]).map((ev) => {
      const [sx, sy] = pos(ev);
      return { ts: ev.timeStamp, x: sx, y: sy };
    });
    const c = ctx(); const prev = cur.samples[cur.samples.length - 1];
    c.strokeStyle = INK_PATH; c.lineWidth = 1; c.beginPath();
    if (prev) c.moveTo(prev.x, prev.y);
    for (const p of subs) { if (prev) c.lineTo(p.x, p.y); else c.moveTo(p.x, p.y); }
    c.stroke();
    for (const p of subs) dot(p.x, p.y, 2.5, INK_SAMPLE);
    dot(x, y, 1.2, INK_EVENT);
    cur.samples.push(...subs);
  };

  const onDown = (e: PointerEvent) => {
    canvas.setPointerCapture(e.pointerId);
    cur = { events: [], samples: [], delegatedMoves: 0 };
    record('down', e);
  };
  const onMove = (e: PointerEvent) => record('move', e);
  const onRaw = (e: Event) => record('raw', e as PointerEvent);
  const onUp = (e: PointerEvent) => {
    if (!cur) return;
    record('up', e);
    const s = summarize(cur); cur = null;
    setSummary(s); setLog((l) => [...l, { ...s, refreshHz: refresh.hz() }]);
  };

  const clear = () => {
    const r = canvas.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
    ctx().setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  onMount(() => {
    clear();
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerrawupdate', onRaw);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
  });
  onCleanup(() => refresh.stop());

  const report = () => JSON.stringify({ ua: navigator.userAgent, api, strokes: log() });

  return (
    <div class={styles.wrap} data-screen="project" data-testid="calibrate-screen">
      <div class={styles.bar}>
        <button class={styles.button} onClick={() => history.back()}>{t('canvas.back')}</button>
        <h2 class={styles.title}>{t('calibrate.title')}</h2>
        <button class={styles.button} onClick={clear} data-testid="calibrate-clear">{t('calibrate.clear')}</button>
      </div>
      <p class={styles.hint}>{t('calibrate.hint')}</p>
      <canvas ref={canvas} class={styles.pad} data-testid="calibrate-pad"
        onPointerMove={() => { if (cur) cur.delegatedMoves++; }} />
      <p class={styles.hint}>
        {t('calibrate.api', { coalesced: String(api.coalesced), predicted: String(api.predicted), raw: String(api.rawupdate) })}
      </p>
      <Show when={summary()} fallback={<p class={styles.hint}>{t('calibrate.refreshLive', { hz: String(refresh.hz()) })}</p>}>
        {(s) => (
          <>
            <dl class={styles.stats} data-testid="calibrate-stats">
              <For each={rows(s(), refresh.hz())}>
                {([k, v]) => (<><dt class={styles.key}>{t(k)}</dt><dd class={styles.val}>{v}</dd></>)}
              </For>
            </dl>
            <p class={styles.hint}>{t('calibrate.reportHint', { n: String(log().length) })}</p>
            <textarea class={styles.report} readOnly value={report()} data-testid="calibrate-report" />
          </>
        )}
      </Show>
    </div>
  );
};

export default CalibrateScreen;
