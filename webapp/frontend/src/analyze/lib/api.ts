import type { AnalyzeData } from './types';

export async function fetchAnalyze(setId: string): Promise<AnalyzeData> {
  const res = await fetch(`/api/analyze/${encodeURIComponent(setId)}`);
  if (!res.ok) throw new Error(`/api/analyze/${setId} returned ${res.status}`);
  return res.json() as Promise<AnalyzeData>;
}
