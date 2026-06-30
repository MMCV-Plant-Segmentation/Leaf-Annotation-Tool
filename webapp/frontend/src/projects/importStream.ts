// Streaming (NDJSON) import/upload client. Reads the chunked response one line at a
// time and invokes a callback per event, reassembling lines that straddle chunk boundaries.

/** Max simultaneous upload POSTs (matches BE _upload_sema). */
const UPLOAD_CONCURRENCY = 4;

export type ImportEvent =
  | { type: 'start'; total: number }
  | { type: 'progress'; loaded: number; total: number }
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
 * POST browser File objects up to UPLOAD_CONCURRENCY at a time using XHR so that
 * xhr.upload.onprogress provides byte-level granularity. Bytes are aggregated across
 * all concurrent workers and emitted as { type: 'progress', loaded, total } events.
 * Emits a synthetic 'start' event upfront, forwards 'file' events per completed file,
 * and finally emits one aggregate 'done'. Concurrency pool and dedup/skip still work.
 */
export async function streamUpload(
  id: string, files: File[], onEvent: (ev: ImportEvent) => void,
): Promise<void> {
  const total = files.length;
  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  const loadedBytes = new Array<number>(total).fill(0);
  onEvent({ type: 'start', total });
  let imported = 0, skipped = 0;
  const errors: { file: string; error: string }[] = [];

  const emitProgress = () => {
    const loaded = loadedBytes.reduce((s, n) => s + n, 0);
    onEvent({ type: 'progress', loaded, total: totalBytes });
  };

  // Shared mutable queue — JS is single-threaded so shift() between awaits is safe.
  const queue = files.map((file, i) => ({ file, i }));

  const worker = async (): Promise<void> => {
    let item;
    while ((item = queue.shift())) {
      const { file, i } = item;
      const fd = new FormData();
      fd.append('files', file);
      await uploadFileXhr(
        `/api/projects/${id}/images/upload`, fd, file.size,
        (loaded) => { loadedBytes[i] = loaded; emitProgress(); },
        (ev) => {
          if (ev.type === 'file') {
            onEvent(ev);
          } else if (ev.type === 'done') {
            imported += ev.imported;
            skipped += ev.skipped;
            errors.push(...ev.errors);
          }
          // absorb per-file 'start' events — the outer start covers the full selection
        },
      );
      // Ensure this file's bytes are fully counted after the response finishes.
      loadedBytes[i] = file.size;
      emitProgress();
    }
  };

  // Spawn min(UPLOAD_CONCURRENCY, total) workers; all drain from the shared queue.
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, total) }, () => worker()));
  onEvent({ type: 'done', imported, skipped, errors });
}

/**
 * XHR-based single-file POST: fires upload byte-progress via onProgress callback,
 * streams the NDJSON response incrementally via xhr.onprogress / responseText.
 */
function uploadFileXhr(
  url: string,
  fd: FormData,
  fileSize: number,
  onProgress: (loaded: number) => void,
  onEvent: (ev: ImportEvent) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);

    // Byte-level upload progress
    xhr.upload.onprogress = (e: ProgressEvent) => {
      if (e.lengthComputable) onProgress(e.loaded);
    };
    xhr.upload.onload = () => onProgress(fileSize);

    // Incremental NDJSON response via responseText accumulation
    let lastLen = 0;
    let buf = '';
    xhr.onprogress = () => {
      buf += xhr.responseText.slice(lastLen);
      lastLen = xhr.responseText.length;
      buf = drainLines(buf, onEvent);
    };

    xhr.onloadend = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        let msg = `HTTP ${xhr.status}`;
        try {
          const d = JSON.parse(xhr.responseText) as { error?: string };
          if (d.error) msg = d.error;
        } catch { /* ignore parse errors on error body */ }
        reject(new Error(msg));
        return;
      }
      // Flush any responseText that arrived without a final onprogress, then drain.
      // The per-file 'done' line is last, so dropping it would zero out imported/skipped.
      buf += xhr.responseText.slice(lastLen);
      lastLen = xhr.responseText.length;
      buf = drainLines(buf, onEvent);
      // Drain any buffered tail (last line with no trailing newline)
      const tail = buf.trim();
      if (tail) onEvent(JSON.parse(tail) as ImportEvent);
      resolve();
    };

    xhr.send(fd);
  });
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
