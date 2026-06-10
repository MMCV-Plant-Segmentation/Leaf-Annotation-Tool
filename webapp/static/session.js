/* ── Session storage key ─────────────────────────────────────────────────── */
const SESSION_KEY = 'lesion-trainer';

/* ── Session state ───────────────────────────────────────────────────────── */
let session = null;

function saveSession() {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function readSession() {
  try {
    const s = localStorage.getItem(SESSION_KEY);
    if (!s) return null;
    const p = JSON.parse(s);
    if (!Array.isArray(p.shapePool) || !p.mode) return null;
    // Migrate pre-versioned sessions (v1 / no version) to v2
    if (!p.version || p.version < 2) {
      p.version = 2;
      p.pairId  = p.pairId ?? 'legacy';
    }
    return p;
  } catch { return null; }
}

function newSession(mode, nCards, pairId) {
  const pool = shuffle([...shapesData.shapes.map((_, i) => i)]).slice(0, nCards);
  session = {
    version:         2,
    pairId,
    mode,
    shapePool:       pool,
    polygonScores:   {},
    labelScores:     {},
    attempts:        {},
    suspended:       [],
    bestAnnotations: {},
  };
  saveSession();
  state.mode = mode;
}

function resumeSession(saved) {
  session = saved;
  state.mode = session.mode;
}

/* ── Priority queue ──────────────────────────────────────────────────────── */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function priority(i) {
  const p = session.polygonScores[i] ?? 0;
  const l = session.labelScores[i]  ?? 0;
  if (session.mode === 'polygon') return p;
  if (session.mode === 'label')   return l;
  return (p + l) / 2;
}

function nextIdx() {
  const avail = session.shapePool.filter(i => !session.suspended.includes(i));
  if (!avail.length) return null;
  const lo = Math.min(...avail.map(priority));
  const candidates = avail.filter(i => priority(i) === lo);
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function avgScores() {
  const tried = session.shapePool.filter(i => (session.attempts[i] ?? 0) > 0);
  const n = tried.length;
  if (!n) return { n: 0, polygon: 0, label: 0 };
  return {
    n,
    polygon: tried.reduce((s, i) => s + (session.polygonScores[i] ?? 0), 0) / n,
    label:   tried.reduce((s, i) => s + (session.labelScores[i]  ?? 0), 0) / n,
  };
}
