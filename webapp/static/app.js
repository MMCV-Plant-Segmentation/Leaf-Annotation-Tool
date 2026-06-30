/* ── Shared data ─────────────────────────────────────────────────────────── */
let shapesData = null;

/* ── Ephemeral state ─────────────────────────────────────────────────────── */
const state = {
  phase:       'setup',
  mode:        'both',
  shapeIdx:    null,
  crop:        null,
  scale:       1,
  verts:       [],
  closed:      false,
  mouse:       null,
  result:      null,
  gtPoints:    null,
  gtOverlay:   'full',
  userOverlay: 'full',
  fromModal:   null,
};

/* ── DOM refs ────────────────────────────────────────────────────────────── */
const canvas         = document.getElementById('canvas');
const ctx            = canvas.getContext('2d');
const progressFill   = document.getElementById('progress-fill');
const avgText        = document.getElementById('avg-text');
const progressSusp   = document.getElementById('progress-susp');
const statTried      = document.getElementById('stat-tried');
const statSusp       = document.getElementById('stat-susp');
const statTotal      = document.getElementById('stat-total');
const cardModal      = document.getElementById('card-modal');
const cardModalGrid  = document.getElementById('card-modal-grid');
const tabTried       = document.getElementById('tab-tried');
const tabSusp        = document.getElementById('tab-susp');
const tabTriedCount  = document.getElementById('tab-tried-count');
const tabSuspCount   = document.getElementById('tab-susp-count');
const retryBadge     = document.getElementById('retry-badge');
const prevScoreBadge = document.getElementById('prev-score-badge');
const polygonSection = document.getElementById('polygon-section');
const labelSection   = document.getElementById('label-section');
const vertCount      = document.getElementById('vert-count');
const snapHint       = document.getElementById('snap-hint');
const labelSelect    = document.getElementById('label-select');
const submitBtn      = document.getElementById('submit-btn');
const undoBtn        = document.getElementById('undo-btn');
const clearBtn       = document.getElementById('clear-btn');
const legendDraw     = document.getElementById('legend-draw');
const drawingPanel   = document.getElementById('drawing-panel');
const revealPanel    = document.getElementById('reveal-panel');
const rDraw          = document.getElementById('r-draw');
const rDrawVal       = document.getElementById('r-draw-val');
const rDrawBest      = document.getElementById('r-draw-best');
const rDrawBestVal   = document.getElementById('r-draw-best-val');
const iouInfoBtn     = document.getElementById('iou-info-btn');
const iouTooltip     = document.getElementById('iou-tooltip');
const iouCalcLines   = document.getElementById('iou-calc-lines');
const rLabel         = document.getElementById('r-label');
const rLabelResult   = document.getElementById('r-label-result');
const rLabelBest     = document.getElementById('r-label-best');
const rLabelBestVal  = document.getElementById('r-label-best-val');
const legendUserRow  = document.getElementById('legend-user-row');
const legendGtRow    = document.getElementById('legend-gt-row');
const nextBtn        = document.getElementById('next-btn');
const redoBtn        = document.getElementById('redo-btn');
const canvasHint     = document.getElementById('canvas-hint');
const doneScreen     = document.getElementById('done-screen');
const setupScreen    = document.getElementById('setup-screen');
const appDiv         = document.getElementById('app');

/* ── Legacy-route whitelist ───────────────────────────────────────────────── */
const _isLegacyRoute = () => {
  const p = location.pathname;
  return p.startsWith('/train') || p.startsWith('/merge');
};

/* ── 401 interceptor: redirect to /login — legacy routes only ───────────────
   On SPA routes the Solid AppRoot handles auth; the legacy interceptor must not
   fire there (BUGS #11 showed the old blacklist was too narrow). */
const _origFetch = window.fetch.bind(window);
window.fetch = function(url, opts) {
  return _origFetch(url, opts).then(res => {
    if (res.status === 401 && typeof url === 'string' && url.startsWith('/api/')
        && url !== '/api/login'
        && _isLegacyRoute()) {
      window.location.href = '/login';
    }
    return res;
  });
};

/* ── Home screen / routing ───────────────────────────────────────────────── */
function showHomeScreen() {
  window._navigate?.('/');
}

function enterTrainingMode() {
  window._navigate?.('/train');
}

function enterComparisonMode() {
  window._navigate?.('/merge');
}

/* ── Init ────────────────────────────────────────────────────────────────── */
let _legacyBooted = false;
window.__bootLegacy = function () {
  if (_legacyBooted || !_isLegacyRoute()) return;
  _legacyBooted = true;
  initModal();
  initTrainer();
  initSetup();
  initCompareSetup();
  initCompare();

  // Wire auth logout buttons in vanilla screens
  document.querySelectorAll('.auth-logout-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await fetch('/api/logout', { method: 'POST' });
      window.location.href = '/login';
    });
  });

  // Load pairs for vanilla screens (auth enforced server-side; 401 → redirect above).
  fetch('/api/images').then(r => r.json()).then(p => { availablePairs = p; });
};
// Direct page load of /train or /merge:
window.__bootLegacy();
