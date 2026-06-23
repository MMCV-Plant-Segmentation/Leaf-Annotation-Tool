import type { PairSummary } from '../analyze/lib/types';

export interface TrainSession {
  pairId: string;
  mode: 'both' | 'polygon' | 'label';
  shapePool: number[];
  polygonScores: Record<number, number>;
  labelScores: Record<number, number>;
  attempts: Record<number, number>;
  suspended: number[];
}

export function calcForkInfo(saved: TrainSession | null, pairs: PairSummary[]): string {
  if (!saved) return '';
  const pair = pairs.find(p => p.id === saved.pairId);
  if (!pair) return '';
  const tried = saved.shapePool.filter(i => (saved.attempts[i] ?? 0) > 0);
  const nt  = tried.length;
  const avg = {
    polygon: nt ? tried.reduce((a, i) => a + (saved.polygonScores[i] ?? 0), 0) / nt : 0,
    label:   nt ? tried.reduce((a, i) => a + (saved.labelScores[i]   ?? 0), 0) / nt : 0,
  };
  const modeLabel = { both: 'polygon + label', polygon: 'polygon only', label: 'label only' }
                      [saved.mode] ?? saved.mode;
  const parts = [
    `<strong>${pair.display_name}</strong>`,
    `${modeLabel} · ${saved.shapePool.length} cards · ${nt} attempted`,
  ];
  if (nt > 0) {
    if (saved.mode !== 'label')   parts.push(`Draw avg: ${Math.round(avg.polygon * 100)}%`);
    if (saved.mode !== 'polygon') parts.push(`Label avg: ${Math.round(avg.label * 100)}%`);
  }
  if (saved.suspended.length > 0) parts.push(`${saved.suspended.length} suspended`);
  return parts.join('<br>');
}
