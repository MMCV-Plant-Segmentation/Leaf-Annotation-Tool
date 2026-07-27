/**
 * t150 — copy the committed geo-engine wasm into the served static assets.
 *
 * The browser and the server must run the SAME stroke engine, so the browser needs the artifact
 * at a URL. Two ways to arrange that were considered:
 *   - serve it from an API route (the D2-a approach) — rejected: it puts a build artifact on the
 *     data API's surface AND forces the geo-engine/ SOURCE dir into the deployed image;
 *   - copy it at build time, FAILING LOUDLY if it is missing or stale — Christian's call, and
 *     the one consistent with "break noisily, never silently".
 *
 * Loud is the whole point: a silently-skipped copy would ship a frontend whose live preview
 * quietly disagrees with what the server stores — exactly the class of bug D2 exists to kill.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const SRC = resolve(REPO, 'geo-engine/geo_engine.wasm');
const DEST = resolve(REPO, 'webapp/static/geo_engine.wasm');

function die(msg) {
  console.error(`\n[copy-wasm] FATAL: ${msg}\n`);
  process.exit(1);
}

if (!existsSync(SRC)) {
  die(`the committed engine is missing at ${SRC}\n`
    + '  Build it with: geo-engine/build-wasm.sh   (then commit the artifact)');
}

const bytes = readFileSync(SRC);
if (bytes.length < 4 || bytes.subarray(0, 4).toString('binary') !== '\0asm') {
  die(`${SRC} is not a WebAssembly module (bad magic) — refusing to ship it`);
}

// Staleness: if a build tree exists and its artifact is NEWER than the committed one, someone
// rebuilt without recommitting. Shipping the stale committed copy would silently disagree with
// the source. (The gate's rust:wasm-diff is the authoritative check; this catches it earlier,
// where the person who just rebuilt is still watching.)
const BUILT = resolve(REPO, 'geo-engine/target/wasm32-unknown-unknown/release/geo_engine.wasm');
if (existsSync(BUILT) && statSync(BUILT).mtimeMs > statSync(SRC).mtimeMs
    && !readFileSync(BUILT).equals(bytes)) {
  die('geo-engine/target/ holds a NEWER, DIFFERENT wasm than the committed artifact.\n'
    + '  You rebuilt the engine but did not recommit it. Copy it over geo-engine/geo_engine.wasm\n'
    + '  (the gate\'s rust:wasm-diff will fail on this too).');
}

mkdirSync(dirname(DEST), { recursive: true });
copyFileSync(SRC, DEST);
console.log(`[copy-wasm] geo_engine.wasm → webapp/static/ (${bytes.length} bytes)`);
