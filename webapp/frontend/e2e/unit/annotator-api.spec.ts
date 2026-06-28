/**
 * Unit tests for annotator API client layer (no server needed — fetch is mocked).
 *
 * Covers:
 *  - projectsApi.create sends name-only body and accepts the response
 *  - projectsApi.addAnnotator sends user_id (not byline)
 *  - projectsApi.listUsers returns {id, username} objects
 *  - projectsApi.updateTileSize sends tile_size_px in the PATCH body
 */

import { test, expect } from '@playwright/test';

// We import the type we want to validate against, plus the API shape
// (We can't import from the compiled src directly in unit context, but we
//  can import the raw TS module since Playwright runs via Node/ts-jest.)

const BASE_URL = '';   // relative paths (mocked)

const _origFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = _origFetch; });

type FetchArgs = { url: string; init?: RequestInit };

function captureFetch(stub: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  let lastCall: FetchArgs | null = null;
  (globalThis as Record<string, unknown>).fetch = async (url: string, init?: RequestInit) => {
    lastCall = { url, init };
    return stub(url, init);
  };
  return () => lastCall;
}

function okJson(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

function errorJson(status: number, body: unknown): Response {
  return {
    ok: false,
    status,
    json: async () => body,
  } as unknown as Response;
}


// ── projectsApi.create ────────────────────────────────────────────────────────

test.describe('projectsApi.create', () => {
  test('sends only name when no extra fields provided', async () => {
    const getCall = captureFetch(() => okJson({ id: 'p1', name: 'Test', tile_size_px: 128,
      black_threshold: 40, classes: [], tiling_confirmed: false,
      created_by: 'admin', created_at: '2026', imageCount: 0, batchCount: 0, annotatorCount: 0 }));

    const { projectsApi } = await import('../../src/projects/api');
    await projectsApi.create({ name: 'Test' });

    const call = getCall();
    expect(call).not.toBeNull();
    expect(call!.url).toBe('/api/projects');
    const sent = JSON.parse(call!.init!.body as string) as Record<string, unknown>;
    expect(sent.name).toBe('Test');
    // No tile_size_px or black_threshold or classes in the body
    expect(sent.tile_size_px).toBeUndefined();
    expect(sent.black_threshold).toBeUndefined();
    expect(sent.classes).toBeUndefined();
  });

  test('throws on error response', async () => {
    captureFetch(() => errorJson(400, { error: 'name required' }));
    const { projectsApi } = await import('../../src/projects/api');
    await expect(projectsApi.create({ name: '' })).rejects.toThrow('name required');
  });
});


// ── projectsApi.addAnnotator ──────────────────────────────────────────────────

test.describe('projectsApi.addAnnotator', () => {
  test('sends user_id in the body (not byline)', async () => {
    const getCall = captureFetch(() => okJson({ ok: true, byline: 'alice', user_id: 7 }));
    const { projectsApi } = await import('../../src/projects/api');
    await projectsApi.addAnnotator('pid1', 7);

    const call = getCall();
    expect(call!.url).toBe('/api/projects/pid1/annotators');
    const sent = JSON.parse(call!.init!.body as string) as Record<string, unknown>;
    expect(sent.user_id).toBe(7);
    expect(sent.byline).toBeUndefined();
  });

  test('throws on 404 (user not found)', async () => {
    captureFetch(() => errorJson(404, { error: 'user not found' }));
    const { projectsApi } = await import('../../src/projects/api');
    await expect(projectsApi.addAnnotator('pid1', 99999)).rejects.toThrow('user not found');
  });
});


// ── projectsApi.listUsers ─────────────────────────────────────────────────────

test.describe('projectsApi.listUsers', () => {
  test('returns array of {id, username} objects', async () => {
    const users = [{ id: 2, username: 'alice' }, { id: 3, username: 'bob' }];
    captureFetch(() => okJson(users));
    const { projectsApi } = await import('../../src/projects/api');
    const result = await projectsApi.listUsers();
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe(2);
    expect(result[0].username).toBe('alice');
  });

  test('sends query param when q is provided', async () => {
    const getCall = captureFetch(() => okJson([{ id: 2, username: 'alice' }]));
    const { projectsApi } = await import('../../src/projects/api');
    await projectsApi.listUsers('ali');
    expect(getCall()!.url).toBe('/api/users/members?q=ali');
  });

  test('omits query param when no q', async () => {
    const getCall = captureFetch(() => okJson([]));
    const { projectsApi } = await import('../../src/projects/api');
    await projectsApi.listUsers();
    expect(getCall()!.url).toBe('/api/users/members');
  });
});


// ── projectsApi.updateTileSize ────────────────────────────────────────────────

test.describe('projectsApi.updateTileSize', () => {
  test('sends tile_size_px in PATCH body', async () => {
    const getCall = captureFetch(() => okJson({ id: 'p1', name: 'T', tile_size_px: 64,
      black_threshold: 40, classes: [], tiling_confirmed: false,
      created_by: 'a', created_at: '2026', imageCount: 0, batchCount: 0, annotatorCount: 0 }));
    const { projectsApi } = await import('../../src/projects/api');
    await projectsApi.updateTileSize('p1', 64);
    const sent = JSON.parse(getCall()!.init!.body as string) as Record<string, unknown>;
    expect(sent.tile_size_px).toBe(64);
  });

  test('throws on 422 when batch exists', async () => {
    captureFetch(() => errorJson(422, { error: 'tile_size_px locked: batch already exists' }));
    const { projectsApi } = await import('../../src/projects/api');
    await expect(projectsApi.updateTileSize('p1', 128)).rejects.toThrow(/locked/);
  });
});
