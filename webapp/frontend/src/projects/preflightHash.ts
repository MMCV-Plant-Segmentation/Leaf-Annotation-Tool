// Pre-flight upload dedup: hash selected files in the browser (reproducing the server's
// hashlib.sha256(bytes).hexdigest()[:24] byte-for-byte), probe the project for which
// hashes it already has, and upload only the missing files. Duplicates never hit the wire.

import { streamUpload, type ImportEvent } from './importStream';

/** Max simultaneous digests (matches the upload pool; keeps a big folder from janking). */
const HASH_CONCURRENCY = 4;

/** Content hash matching the backend: SHA-256 of the raw bytes, hex, first 24 chars. */
export async function hashFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  return hex.slice(0, 24);
}

/**
 * Hash every file, at most HASH_CONCURRENCY at a time, reading each lazily (one
 * arrayBuffer in flight per worker) to cap memory on large selections. Returns hashes
 * index-aligned with `files`.
 */
export async function hashFiles(files: File[]): Promise<string[]> {
  const hashes = new Array<string>(files.length);
  const queue = files.map((file, i) => ({ file, i }));
  const worker = async (): Promise<void> => {
    let item;
    while ((item = queue.shift())) {
      hashes[item.i] = await hashFile(item.file);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(HASH_CONCURRENCY, files.length) }, () => worker()),
  );
  return hashes;
}

/** Ask the project which of these content hashes it already has. Read-only; no bytes. */
export async function probeHashes(id: string, hashes: string[]): Promise<Set<string>> {
  const r = await fetch(`/api/projects/${id}/images/probe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hashes }),
  });
  if (!r.ok) {
    const data = (await r.json().catch(() => null)) as { error?: string } | null;
    throw new Error((data && data.error) || `HTTP ${r.status}`);
  }
  const out = (await r.json()) as { have: string[] };
  return new Set(out.have);
}

/**
 * Hash → probe → upload ONLY the missing files. Files the project already has are
 * reported via onSkipped (so the UI can badge them) and never hit the network. Upload
 * events are forwarded unchanged via onEvent; when nothing is missing we still emit a
 * synthetic start+done so callers can render a summary.
 */
export async function uploadWithPreflight(
  id: string, files: File[],
  onEvent: (ev: ImportEvent) => void,
  onSkipped: (present: File[]) => void,
): Promise<void> {
  const hashes = await hashFiles(files);
  const have = await probeHashes(id, hashes);
  const present = files.filter((_, i) => have.has(hashes[i]!));
  const missing = files.filter((_, i) => !have.has(hashes[i]!));
  onSkipped(present);
  if (missing.length) {
    await streamUpload(id, missing, onEvent);
  } else {
    onEvent({ type: 'start', total: 0 });
    onEvent({ type: 'done', imported: 0, skipped: 0, errors: [] });
  }
}
