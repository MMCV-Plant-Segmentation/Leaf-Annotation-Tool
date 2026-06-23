/* ── Pair state ──────────────────────────────────────────────────────────── */
let selectedPairId = null;
var availablePairs = []; // var so window.availablePairs is visible to ES-module bundle

/* ── Pair data fetch (used by bridge launch functions) ───────────────────── */
async function _fetchPairData(pairId) {
  selectedPairId = pairId;
  shapesData = await fetch(`/api/shapes?pair=${encodeURIComponent(pairId)}`).then(r => r.json());
}


/* ── Enter app ───────────────────────────────────────────────────────────── */
function enterApp() {
  labelSelect.innerHTML = '<option value="">— choose —</option>';
  shapesData.labels.forEach(l => {
    const opt = document.createElement('option');
    opt.value = opt.textContent = l;
    labelSelect.appendChild(opt);
  });
  setupScreen.hidden = true;
  appDiv.hidden      = false;
  updateHeader();
  loadCard();
}

/* ── Bridge functions (called by Solid TrainScreen) ──────────────────────── */
window._readSession  = readSession;
window._clearSession = function() { localStorage.removeItem(SESSION_KEY); session = null; };

window._launchTrainer = async function(pairId, mode, n) {
  await _fetchPairData(pairId);
  newSession(mode, n, pairId);
  enterApp();
};

window._resumeTrainer = async function(saved) {
  await _fetchPairData(saved.pairId);
  resumeSession(saved);
  enterApp();
};

/* ── Setup init ──────────────────────────────────────────────────────────── */
function initSetup() {
  // Trainer viewer: Home button → back to home screen
  document.getElementById('home-btn').addEventListener('click', () => {
    appDiv.hidden      = true;
    setupScreen.hidden = false;
    showHomeScreen();
  });

  // Done screen: Reset → home screen
  document.getElementById('play-again-btn').addEventListener('click', () => {
    localStorage.removeItem(SESSION_KEY);
    session = null;
    doneScreen.hidden  = true;
    appDiv.hidden      = true;
    setupScreen.hidden = false;
    showHomeScreen();
  });
}
