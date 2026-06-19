import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchAnalyze } from '../src/analyze/lib/api';
import type { AnalyzeData } from '../src/analyze/lib/types';

const MOCK_DATA: AnalyzeData = {
  setId: 'abc123',
  displayName: 'Test Merge Set',
  imageHash: 'deadbeef',
  imageWidth: 640,
  imageHeight: 480,
  mTotal: 3,
  piles: [
    {
      id: 'P0',
      m: 3,
      bbox: [10, 20, 50, 60],
      agreementByK: {
        '1': { fraction: 1.0, rings: [[[10,20],[50,20],[50,60],[10,60]]] },
        '2': { fraction: 0.8, rings: [] },
        '3': { fraction: 0.5, rings: [] },
      },
      sourceRings: [],
    },
  ],
};

afterEach(() => { vi.restoreAllMocks(); });

describe('fetchAnalyze', () => {
  it('returns parsed AnalyzeData on 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(MOCK_DATA),
    }));

    const result = await fetchAnalyze('abc123');
    expect(result.setId).toBe('abc123');
    expect(result.mTotal).toBe(3);
    expect(result.piles).toHaveLength(1);
    expect(result.piles[0].agreementByK['2'].fraction).toBeCloseTo(0.8);
  });

  it('calls the correct URL with encoded setId', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(MOCK_DATA),
    });
    vi.stubGlobal('fetch', mockFetch);

    await fetchAnalyze('some set/id');
    expect(mockFetch).toHaveBeenCalledWith('/api/analyze/some%20set%2Fid');
  });

  it('throws on non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
    }));

    await expect(fetchAnalyze('bad-id')).rejects.toThrow('400');
  });
});
