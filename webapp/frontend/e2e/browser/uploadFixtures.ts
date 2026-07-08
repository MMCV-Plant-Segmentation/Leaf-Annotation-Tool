import fs from 'fs';
import { test } from '@playwright/test';

/**
 * Per-test UNIQUE upload payloads for the browser upload/dedup specs.
 *
 * The content store is content-addressed GLOBALLY — re-uploading bytes that exist in ANY
 * project dedups to "skipped" (that's the feature, BUGS #26). So any two uploads sharing bytes
 * are NOT isolated: whichever runs second sees the other's bytes already present and its "fresh
 * import" turns into "skipped". Every upload that expects a fresh import must own its bytes —
 * and "own" spans the whole gate run: the `fast` and `full` projects (and any retry) execute the
 * same specs against the SAME server/store, so the scope must include the run, not just the tag.
 *
 * uniquePng() takes a real seeded fixture PNG and appends a trailer scoped by the live test id +
 * retry + `tag`. Trailing bytes after the IEND chunk are ignored by decoders (Pillow included),
 * so it stays a valid, decodable image — but the raw bytes (hence the sha256 the store dedups on)
 * are unique per (project, test, attempt, tag). Upload via setInputFiles({ name, mimeType, buffer }).
 * Build the payload array ONCE per test and reuse it for a deliberate re-upload (the dedup path).
 */
export type UploadPayload = { name: string; mimeType: string; buffer: Buffer };

export function uniquePng(basePngPath: string, tag: string): UploadPayload {
  const info = test.info();
  const scope = `${info.testId}:${info.retry}`;   // distinct across fast/full projects + retries
  const bytes = fs.readFileSync(basePngPath);
  const trailer = Buffer.from(`\n[e2e-unique:${scope}:${tag}]`);
  return { name: `${tag}.png`, mimeType: 'image/png', buffer: Buffer.concat([bytes, trailer]) };
}

/** `n` unique payloads tagged `<tag>-0..n-1`, each built from a rotating seeded base image. */
export function uniquePngs(flatDir: string, tag: string, n: number): UploadPayload[] {
  return Array.from({ length: n }, (_, i) => uniquePng(`${flatDir}/upload${i % 3}.png`, `${tag}-${i}`));
}
