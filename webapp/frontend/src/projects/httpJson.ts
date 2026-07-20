// Tiny shared fetch helpers — split out so api.ts and canvasApi.ts can both use them
// without a circular import between the two (api.ts re-exports canvasApi.ts's surface).

/** A failed jfetch(): `.message` is the server's `error` text; `.body` is the full
 * parsed JSON error body, so a caller that needs a structured field (e.g. t64's
 * `blockedCompoundId` — see LabelEditor.tsx) doesn't have to parse the message text. */
export class ApiError extends Error {
  body: unknown;
  constructor(message: string, body: unknown) {
    super(message);
    this.name = 'ApiError';
    this.body = body;
  }
}

export async function jfetch<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  const data = (await r.json().catch(() => null)) as T & { error?: string };
  if (!r.ok) throw new ApiError((data && (data as { error?: string }).error) || `HTTP ${r.status}`, data);
  return data;
}

export function jbody(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
