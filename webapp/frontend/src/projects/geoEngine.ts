/**
 * t104/D2 — the browser half of the shared stroke engine.
 *
 * The server has derived every stroke's geometry from the geo-engine wasm since D1; the
 * browser still drew its own outline with perfect-freehand, so what you SAW while drawing and
 * what got STORED came from two different implementations. This module removes that split: the
 * FE calls the SAME wasm, fetched as the SAME committed artifact the server executes
 * (/api/geo-engine.wasm), so preview and stored mask agree by construction.
 *
 * Mirrors webapp/geo_engine.py's surface (outlinePolyline / outlineBrush / fuse) over the same
 * ABI: JSON in, length-prefixed JSON out, through the module's own alloc/dealloc.
 */

export type Ring = number[][];

type Exports = {
  memory: WebAssembly.Memory;
  alloc: (len: number) => number;
  dealloc: (ptr: number, len: number) => void;
  process: (ptr: number, len: number) => number;
};

let enginePromise: Promise<Exports> | null = null;

/** Instantiate from raw bytes. The crate imports nothing, so an empty import object is the
 * whole contract. Exposed so a test can feed the committed artifact straight off disk. */
export function instantiateGeoEngine(bytes: BufferSource): Promise<Exports> {
  return WebAssembly.instantiate(bytes, {}).then(
    (res) => res.instance.exports as unknown as Exports);
}

/** Fetch + instantiate the engine once; later callers share the same instance. */
export function loadGeoEngine(url = '/api/geo-engine.wasm'): Promise<Exports> {
  if (!enginePromise) {
    enginePromise = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`geo-engine wasm fetch failed: ${r.status}`);
        return r.arrayBuffer();
      })
      .then(instantiateGeoEngine)
      .catch((err) => { enginePromise = null; throw err; });  // let a retry re-fetch
  }
  return enginePromise;
}

/** Seed the shared instance (tests). */
export function setGeoEngine(ex: Exports): void {
  enginePromise = Promise.resolve(ex);
}

/** Reset the cached instance — tests only. */
export function resetGeoEngine(): void {
  enginePromise = null;
}

function call(ex: Exports, req: unknown): { rings?: Ring[]; error?: string } {
  const reqBytes = new TextEncoder().encode(JSON.stringify(req));
  const reqPtr = ex.alloc(reqBytes.length);
  let respPtr: number;
  try {
    new Uint8Array(ex.memory.buffer, reqPtr, reqBytes.length).set(reqBytes);
    respPtr = ex.process(reqPtr, reqBytes.length);
  } finally {
    ex.dealloc(reqPtr, reqBytes.length);
  }
  // Response is a 4-byte little-endian length followed by that many UTF-8 bytes. Read the
  // length through a fresh view: `process` can grow memory, detaching any earlier buffer.
  const respLen = new DataView(ex.memory.buffer).getUint32(respPtr, true);
  const body = new Uint8Array(ex.memory.buffer, respPtr + 4, respLen).slice();
  ex.dealloc(respPtr, 4 + respLen);
  return JSON.parse(new TextDecoder().decode(body));
}

function rings(resp: { rings?: Ring[]; error?: string }): Ring[] {
  if (resp.error) throw new Error(`geo-engine: ${resp.error}`);
  return resp.rings ?? [];
}

// The engine answers MALFORMED input with an empty ring list rather than an error (verified
// on both bindings: mismatched radii, no points, and a negative size all return []). Empty
// rings mean "this stroke has no geometry", so a caller bug would make a stroke silently
// VANISH instead of failing. Guard at the boundary so it breaks noisily here. The engine
// itself still needs fixing — see the t104 follow-up ticket; that needs a wasm rebuild.
function reject(cond: boolean, msg: string): void {
  if (cond) throw new Error(`geo-engine: ${msg}`);
}

/** Outline a polyline stroke — round joins/caps, per-vertex radius. */
export async function outlinePolyline(points: Ring, radii: number[]): Promise<Ring[]> {
  reject(points.length < 2, `polyline needs >= 2 points, got ${points.length}`);
  reject(radii.length !== points.length,
    `polyline needs one radius per point, got ${radii.length} for ${points.length} points`);
  reject(radii.some((r) => !(r > 0)), 'polyline radii must all be > 0');
  const ex = await loadGeoEngine();
  return rings(call(ex, { op: 'outline', kind: 'polyline', points, radii }));
}

/** Outline a freehand brush stroke of constant `size`. */
export async function outlineBrush(points: Ring, size: number): Promise<Ring[]> {
  reject(points.length < 1, 'brush needs at least one point');
  reject(!(size > 0), `brush size must be > 0, got ${size}`);
  const ex = await loadGeoEngine();
  return rings(call(ex, { op: 'outline', kind: 'brush', points, size }));
}

/** Union polygons into the fused mask — the real-time fusion the FE could not do before. */
export async function fuse(polygons: Ring[]): Promise<Ring[]> {
  const ex = await loadGeoEngine();
  return rings(call(ex, { op: 'fuse', polygons }));
}
