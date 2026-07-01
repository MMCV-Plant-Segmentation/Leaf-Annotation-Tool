// Tiny shared fetch helpers — split out so api.ts and canvasApi.ts can both use them
// without a circular import between the two (api.ts re-exports canvasApi.ts's surface).

export async function jfetch<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  const data = (await r.json().catch(() => null)) as T & { error?: string };
  if (!r.ok) throw new Error((data && (data as { error?: string }).error) || `HTTP ${r.status}`);
  return data;
}

export function jbody(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
