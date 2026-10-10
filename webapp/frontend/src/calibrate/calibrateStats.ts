// t157: pure stroke statistics for the input-calibration page. Answers "what does THIS browser +
// device actually deliver?" — events vs coalesced samples, real rates, duplicate deliveries, and
// which of pressure/tilt/twist/altitude carry signal. No DOM, no framework: testable in Node.

/** One delivered pointer event (as seen by the page's own direct listener). */
export type CalEvent = {
  kind: 'down' | 'move' | 'up' | 'raw';
  ts: number; x: number; y: number;
  coalesced: number;        // getCoalescedEvents().length (0 = API missing or empty)
  predicted: number;        // getPredictedEvents().length
  pressure: number; tiltX: number; tiltY: number; twist: number;
  altitude: number | null; azimuth: number | null;
  pointerType: string;
};

/** One position sample: a coalesced sub-event, or the event itself when none are offered. */
export type CalSample = { ts: number; x: number; y: number };

export type CalStroke = {
  events: CalEvent[];
  samples: CalSample[];
  delegatedMoves: number;   // pointermove calls seen through the framework's delegated handler
};

export type CalSummary = {
  pointerType: string;
  durationMs: number;
  moveEvents: number;
  delegatedMoves: number;
  duplicateMoves: number;
  coalescedTotal: number;
  coalescedMaxPerEvent: number;
  predictedMaxPerEvent: number;
  rawUpdates: number;
  eventHz: number;
  sampleHz: number;
  medianSampleDtMs: number;
  subMsTimestamps: number;  // fraction of samples whose timestamp has a fractional ms part
  pressure: [number, number];
  tiltX: [number, number];
  tiltY: [number, number];
  twist: [number, number];
  altitudeReported: boolean;
};

const range = (xs: number[]): [number, number] =>
  xs.length ? [Math.min(...xs), Math.max(...xs)] : [0, 0];

const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

/** Rate over DISTINCT timestamps — exact duplicates don't inflate it. */
export function distinctRateHz(ts: number[]): number {
  const u = [...new Set(ts)].sort((a, b) => a - b);
  if (u.length < 2) return 0;
  const span = u[u.length - 1] - u[0];
  return span > 0 ? round(((u.length - 1) * 1000) / span) : 0;
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** A move event identical (time + position) to the previous move — a double delivery. */
export function countDuplicateMoves(events: CalEvent[]): number {
  const moves = events.filter((e) => e.kind === 'move');
  let n = 0;
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1], b = moves[i];
    if (a.ts === b.ts && a.x === b.x && a.y === b.y) n++;
  }
  return n;
}

export function summarize(s: CalStroke): CalSummary {
  const moves = s.events.filter((e) => e.kind === 'move');
  const real = s.events.filter((e) => e.kind !== 'raw');
  const sampleTs = s.samples.map((p) => p.ts);
  const uniq = [...new Set(sampleTs)].sort((a, b) => a - b);
  const dts = uniq.slice(1).map((v, i) => v - uniq[i]);
  const allTs = s.events.map((e) => e.ts);
  return {
    pointerType: real[0]?.pointerType ?? '',
    durationMs: allTs.length ? round(Math.max(...allTs) - Math.min(...allTs)) : 0,
    moveEvents: moves.length,
    delegatedMoves: s.delegatedMoves,
    duplicateMoves: countDuplicateMoves(s.events),
    coalescedTotal: moves.reduce((a, e) => a + e.coalesced, 0),
    coalescedMaxPerEvent: Math.max(0, ...moves.map((e) => e.coalesced)),
    predictedMaxPerEvent: Math.max(0, ...moves.map((e) => e.predicted)),
    rawUpdates: s.events.filter((e) => e.kind === 'raw').length,
    eventHz: distinctRateHz(moves.map((e) => e.ts)),
    sampleHz: distinctRateHz(sampleTs),
    medianSampleDtMs: round(median(dts), 2),
    subMsTimestamps: sampleTs.length
      ? round(sampleTs.filter((v) => v !== Math.floor(v)).length / sampleTs.length, 2) : 0,
    pressure: range(real.map((e) => round(e.pressure, 3))),
    tiltX: range(real.map((e) => e.tiltX)),
    tiltY: range(real.map((e) => e.tiltY)),
    twist: range(real.map((e) => e.twist)),
    altitudeReported: real.some((e) => e.altitude != null),
  };
}
