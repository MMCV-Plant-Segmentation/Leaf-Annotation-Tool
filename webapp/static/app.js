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
const cbPolygon      = document.getElementById('cb-polygon');
const cbLabel        = document.getElementById('cb-label');
const startBtn       = document.getElementById('start-btn');
const modeError      = document.getElementById('mode-error');
const nSlider        = document.getElementById('n-slider');
const nDisplay       = document.getElementById('n-display');

/* ── B.1 Byline identity ─────────────────────────────────────────────────── */
const BYLINE_KEY = 'lesion-user';

function getUser() {
  return (localStorage.getItem(BYLINE_KEY) || '').trim() || null;
}

function setUser(name) {
  localStorage.setItem(BYLINE_KEY, name.trim());
  _syncBylineButtons();
}

function _syncBylineButtons() {
  const name = getUser() || 'anonymous';
  const label = name.length > 18 ? name.slice(0, 16) + '…' : name;
  document.querySelectorAll('.btn-byline-change').forEach(btn => {
    btn.textContent = label;
    btn.title = 'Signed in as ' + name + ' — click to change';
  });
}

/* ── Byline modal ────────────────────────────────────────────────────────── */
function openBylineModal(onConfirm) {
  const modal   = document.getElementById('byline-modal');
  const input   = document.getElementById('byline-input');
  const errEl   = document.getElementById('byline-error');
  const confirmBtn = document.getElementById('byline-confirm-btn');
  const backdrop   = document.getElementById('byline-backdrop');

  // Dismissible only when a name already exists (i.e. opened via "change name").
  // On first load there is no stored user, so the modal is mandatory.
  const cancelable = !!getUser();

  input.value = getUser() || '';
  errEl.hidden = true;
  modal.hidden = false;
  input.focus();
  input.select();

  function doConfirm() {
    const name = input.value.trim();
    if (!name) { errEl.hidden = false; return; }
    modal.hidden = true;
    setUser(name);
    cleanup();
    if (onConfirm) onConfirm();
  }

  function doCancel() {
    if (!cancelable) return;
    modal.hidden = true;
    cleanup();
  }

  function cleanup() {
    confirmBtn.removeEventListener('click', doConfirm);
    input.removeEventListener('keydown', onKey);
    if (backdrop) backdrop.removeEventListener('click', doCancel);
  }

  function onKey(e) {
    if (e.key === 'Enter') { e.preventDefault(); doConfirm(); }
    else if (e.key === 'Escape') { e.preventDefault(); doCancel(); }
  }

  confirmBtn.addEventListener('click', doConfirm);
  input.addEventListener('keydown', onKey);
  if (backdrop) backdrop.addEventListener('click', doCancel);
}

/* ── X-User header plumbing: wrap fetch ──────────────────────────────────── */
const _origFetch = window.fetch.bind(window);
window.fetch = function(url, opts) {
  // Only augment same-origin /api/ calls
  if (typeof url === 'string' && url.startsWith('/api/')) {
    opts = opts || {};
    const headers = new Headers(opts.headers || {});
    const user = getUser();
    if (user) headers.set('X-User', user);
    opts = { ...opts, headers };
  }
  return _origFetch(url, opts);
};

/* ── Home screen / routing ───────────────────────────────────────────────── */
function showHomeScreen() {
  _hideAllSetupScreens();
  document.getElementById('home-screen').hidden = false;
}

async function enterTrainingMode() {
  _hideAllSetupScreens();
  const saved = readSession();
  if (saved && availablePairs.some(p => p.id === saved.pairId)) {
    await selectPair(saved.pairId);
    showFork(saved);
  } else {
    if (saved) {
      document.getElementById('session-deleted-notice').hidden = false;
      localStorage.removeItem(SESSION_KEY);
    }
    if (availablePairs.length > 0) await selectPair(availablePairs[0].id);
    showConfig(false);
  }
}

async function enterComparisonMode() {
  _hideAllSetupScreens();
  const saved = await readCompareSession();
  if (saved) showCompareFork(saved);
  else showCompareSetup();
}

/* ── Init ────────────────────────────────────────────────────────────────── */
(async () => {
  initModal();
  initTrainer();
  initSetup();
  initCompareSetup();
  initCompare();
  initAnalyze();

  // Wire change-name buttons in both headers
  document.querySelectorAll('.btn-byline-change').forEach(btn => {
    btn.addEventListener('click', () => openBylineModal(null));
  });

  // First load: show byline modal if no name stored, then load pairs
  async function afterByline() {
    const pairs = await fetch('/api/images').then(r => r.json());
    renderPairList(pairs);

    document.getElementById('tile-manage').addEventListener('click', showManageScreen);
    document.getElementById('tile-merge').addEventListener('click', enterComparisonMode);
    document.getElementById('tile-train').addEventListener('click', enterTrainingMode);
    document.getElementById('tile-analyze').addEventListener('click', showAnalyzeSetup);
    // tile-reannotate is disabled (coming in a later phase)
  }

  if (!getUser()) {
    openBylineModal(afterByline);
  } else {
    _syncBylineButtons();
    await afterByline();
  }
})();
