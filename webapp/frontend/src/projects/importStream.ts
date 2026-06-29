// Streaming (NDJSON) import/upload client. Reads the chunked response one line at a
// time and invokes a callback per event, reassembling lines that straddle chunk boundaries.

export type ImportEvent =
  | { type: 'start'; total: number }
  | { type: 'uploading'; index: number; total: number }
  | { type: 'file'; name: string; path: string; ok: boolean; imported?: boolean; skipped?: boolean; error?: string }
  | { type: 'done'; imported: number; skipped: number; errors: { file: string; error: string }[] };

/** POST a server path, read the NDJSON stream, invoking onEvent per line. */
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
  await readNdjsonStream(r.body, onEvent);
}

/**
 * POST browser File objects one at a time, streaming NDJSON per file.
 * Emits a synthetic 'start' event upfront, then an 'uploading' event before each
 * file's POST (showing "Uploading N of M" in the UI), then forwards each 'file'
 * event, and finally emits a single aggregate 'done' event.
 */
export async function streamUpload(
  id: string, files: File[], onEvent: (ev: ImportEvent) => void,
): Promise<void> {
  const total = files.length;
  onEvent({ type: 'start', total });
  let imported = 0, skipped = 0;
  const errors: { file: string; error: string }[] = [];
  for (let i = 0; i < files.length; i++) {
    onEvent({ type: 'uploading', index: i + 1, total });
    const fd = new FormData();
    fd.append('files', files[i]);
    const r = await fetch(`/api/projects/${id}/images/upload`, { method: 'POST', body: fd });
    if (!r.ok || !r.body) {
      const data = (await r.json().catch(() => null)) as { error?: string } | null;
      throw new Error((data && data.error) || `HTTP ${r.status}`);
    }
    await readNdjsonStream(r.body, (ev) => {
      if (ev.type === 'file') onEvent(ev);
      else if (ev.type === 'done') {
        imported += ev.imported;
        skipped += ev.skipped;
        errors.push(...ev.errors);
      }
      // absorb per-file 'start' events — the outer start covers the full selection
    });
  }
  onEvent({ type: 'done', imported, skipped, errors });
}

async function readNdjsonStream(
  body: ReadableStream<Uint8Array>, onEvent: (ev: ImportEvent) => void,
): Promise<void> {
  const reader = body.getReader();
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
