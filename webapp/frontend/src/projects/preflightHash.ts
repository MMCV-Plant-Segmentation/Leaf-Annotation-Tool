// Pre-flight upload dedup: hash selected files in the browser (reproducing the server's
// hashlib.sha256(bytes).hexdigest()[:24] byte-for-byte), probe the GLOBAL content store for
// which hashes already exist on disk anywhere, register the already-stored ones into THIS
// project by hash (no bytes re-sent), and upload only the genuinely-missing files.
// BUGS #26: dedup is GLOBAL — images live in one content-addressed pile; the DB still
// guards which project sees which image, so registering a hash into a project does NOT leak
// its content across projects beyond what Christian approved.

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

/** Ask the GLOBAL store which of these content hashes already exist on disk. Read-only;
 * no bytes. Returns the set of hashes whose bytes are present ANYWHERE (any project). */
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
 * Register already-stored images into THIS project by content hash — no bytes re-sent.
 * Returns the subset of `hashes` that are genuinely missing from the global store and
 * therefore still need a full upload. Files already in this project are a no-op
 * (UNIQUE(project_id, image_hash) on the server).
 */
export async function registerStored(
  id: string,
  items: { hash: string; name: string }[],
): Promise<{ registered: Set<string>; missing: Set<string> }> {
  if (items.length === 0) return { registered: new Set(), missing: new Set() };
  const r = await fetch(`/api/projects/${id}/images/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  });
  if (!r.ok) {
    const data = (await r.json().catch(() => null)) as { error?: string } | null;
    throw new Error((data && data.error) || `HTTP ${r.status}`);
  }
  const out = (await r.json()) as { registered: string[]; missing: string[] };
  return { registered: new Set(out.registered), missing: new Set(out.missing) };
}

/**
 * Hash → probe (GLOBAL) → register the already-stored ones into this project by hash
 * (no bytes) → upload ONLY the genuinely-missing files. Files whose bytes already exist
 * anywhere are reported via onSkipped (badged "already imported") and never hit the
 * upload wire; registering them makes the image appear in THIS project. Upload events are
 * forwarded unchanged via onEvent; when nothing is missing we still emit a synthetic
 * start+done so callers can render a summary.
 */
export async function uploadWithPreflight(
  id: string, files: File[],
  onEvent: (ev: ImportEvent) => void,
  onSkipped: (present: File[]) => void,
): Promise<void> {
  const hashes = await hashFiles(files);
  const have = await probeHashes(id, hashes);
  // Globally-present files: register into this project by hash (no bytes re-sent). Work in
  // index space so duplicate File refs can't confuse a File→index lookup.
  const presentIdx = files.map((_, i) => i).filter((i) => have.has(hashes[i]!));
  const missingIdx = files.map((_, i) => i).filter((i) => !have.has(hashes[i]!));
  const skipped: File[] = [];
  if (presentIdx.length) {
    const items = presentIdx.map((i) => ({ hash: hashes[i]!, name: files[i]!.name }));
    const { missing } = await registerStored(id, items);
    for (const i of presentIdx) {
      if (missing.has(hashes[i]!)) {
        // Race / store miss: server says the bytes aren't actually there → full upload.
        missingIdx.push(i);
      } else {
        skipped.push(files[i]!); // registered (or already in this project) — badge, no upload.
      }
    }
  }
  onSkipped(skipped);
  const toUpload = missingIdx.map((i) => files[i]!);
  if (toUpload.length) {
    await streamUpload(id, toUpload, onEvent);
  } else {
    onEvent({ type: 'start', total: 0 });
    onEvent({ type: 'done', imported: 0, skipped: 0, errors: [] });
  }
}
