import { test, expect } from '@playwright/test';
import { fetchAnalyze } from '../../src/analyze/lib/api';
import type { AnalyzeData } from '../../src/analyze/lib/types';

const MOCK_DATA: AnalyzeData = {
  setId: 'abc123',
  displayName: 'Test Merge Set',
  imageHash: 'deadbeef',
  imageWidth: 640,
  imageHeight: 480,
  mTotal: 3,
  piles: [{
    id: 'P0', m: 3, bbox: [10, 20, 50, 60],
    agreementByK: {
      '1': { fraction: 1.0, rings: [[[10,20],[50,20],[50,60],[10,60]]] },
      '2': { fraction: 0.8, rings: [] },
      '3': { fraction: 0.5, rings: [] },
    },
    sourceRings: [],
  }],
};

const _origFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = _origFetch; });

function mockFetch(response: Partial<Response> & { json?: () => Promise<unknown> }) {
  (globalThis as Record<string, unknown>).fetch = async () => response;
}

test.describe('fetchAnalyze', () => {
  test('returns parsed AnalyzeData on 200', async () => {
    mockFetch({ ok: true, json: async () => MOCK_DATA });
    const result = await fetchAnalyze('abc123');
    expect(result.setId).toBe('abc123');
    expect(result.mTotal).toBe(3);
    expect(result.piles).toHaveLength(1);
    expect(result.piles[0].agreementByK['2'].fraction).toBeCloseTo(0.8);
  });

  test('calls the correct URL with encoded setId', async () => {
    let calledUrl = '';
    (globalThis as Record<string, unknown>).fetch = async (url: string) => {
      calledUrl = url;
      return { ok: true, json: async () => MOCK_DATA };
    };
    await fetchAnalyze('some set/id');
    expect(calledUrl).toBe('/api/analyze/some%20set%2Fid');
  });

  test('throws on non-ok response', async () => {
    mockFetch({ ok: false, status: 400 } as Response);
    await expect(fetchAnalyze('bad-id')).rejects.toThrow('400');
  });
});
