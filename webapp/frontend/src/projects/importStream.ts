// Streaming (NDJSON) import client. Reads the chunked response one line at a time and
// invokes a callback per event, reassembling lines that straddle chunk boundaries.

export type ImportEvent =
  | { type: 'start'; total: number }
  | { type: 'file'; name: string; path: string; ok: boolean; imported?: boolean; skipped?: boolean; error?: string }
  | { type: 'done'; imported: number; skipped: number; errors: { file: string; error: string }[] };

/** POST a path, read the NDJSON stream, invoking onEvent per line. */
export async function streamImport(
  id: string, path: string, onEvent: (ev: ImportEvent) => void,
): Promise<void> {
  const r = await fetch(`/api/projects/${id}/images/import/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!r.ok || !r.body) {
    const data = (await r.json().catch(() => null)) as { error?: string } | null;
    throw new Error((data && data.error) || `HTTP ${r.status}`);
  }
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    buf = drainLines(buf, onEvent);
  }
  const tail = buf.trim();
  if (tail) onEvent(JSON.parse(tail) as ImportEvent);
}

/** Emit one onEvent per complete line in buf; return the unconsumed remainder. */
function drainLines(buf: string, onEvent: (ev: ImportEvent) => void): string {
  let nl = buf.indexOf('\n');
  while (nl >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) onEvent(JSON.parse(line) as ImportEvent);
    nl = buf.indexOf('\n');
  }
  return buf;
}
