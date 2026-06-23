/* ── Comparison session storage ──────────────────────────────────────────── */
const MERGE_ID_KEY = 'lesion-compare-id';
let compareSession = null;

function saveCompareSession() {
  const mergeId = localStorage.getItem(MERGE_ID_KEY);
  if (!mergeId) return;
  fetch(`/api/merges/${mergeId}`, {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ doc: compareSession }),
  }).catch(e => console.warn('saveCompareSession failed:', e));
}

async function readCompareSession() {
  const mergeId = localStorage.getItem(MERGE_ID_KEY);
  if (!mergeId) return null;
  try {
    const r = await fetch(`/api/merges/${mergeId}`);
    if (!r.ok) { localStorage.removeItem(MERGE_ID_KEY); return null; }
    const data = await r.json();
    const p = data.doc;
    if (!p || !p.imageHash || !Array.isArray(p.includedSetIds)) return null;
    if (!availablePairs.some(q => q.image_hash === p.imageHash)) return null;
    if (!p.includedSetIds.some(id => availablePairs.some(q => q.id === id))) return null;
    // Migrations
    (p.annotations || []).forEach((ann, i) => {
      if (!ann.overlay) ann.overlay = 'outline';
      if (!ann.num)     ann.num     = i + 1;
    });
    if (p.blind      === undefined) p.blind      = true;
    if (p.finalBlind === undefined) p.finalBlind = true;
    if (!p.globalColors) p.globalColors = _makeGlobalColors(p.includedSetIds || []);
    if (!p.edges)        p.edges        = [];
    Object.values(p.piles || {}).forEach(pile => {
      if (pile.showBbox === undefined) pile.showBbox = false;
    });
    return p;
  } catch { localStorage.removeItem(MERGE_ID_KEY); return null; }
}

/* ── Screen helpers ──────────────────────────────────────────────────────── */
function _hideAllSetupScreens() {
  // All setup screens are now Solid routes; nothing to hide here
}

/* ── Session seeding helpers ─────────────────────────────────────────────── */
function _makeGlobalColors(setIds) {
  const palette = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22'];
  const sorted  = [...setIds].sort();
  const colors  = {};
  sorted.forEach((sid, i) => { colors[sid] = palette[i % palette.length]; });
  return colors;
}

function _isConflict(ids, includedSetIds, annById) {
  const counts = Object.fromEntries(includedSetIds.map(id => [id, 0]));
  for (const id of ids) counts[annById[id].setId]++;
  const vals = Object.values(counts);
  return vals.some(v => v !== vals[0]);
}

function _makeColors(ids, annById) {
  const palette = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22'];
  const setIds  = [...new Set(ids.map(id => annById[id].setId))].sort();
  const shuffled = [...palette].sort(() => Math.random() - 0.5);
  const colors = {};
  setIds.forEach((sid, i) => { colors[sid] = shuffled[i % shuffled.length]; });
  return colors;
}

/* ── Bridge functions (called by Solid MergeScreen) ─────────────────────── */
window._readCompareSession = readCompareSession;

window._resumeCompare = function(saved) {
  compareSession = saved;
  showCompareGrouping();
};

window._deleteCompare = async function() {
  const mergeId = localStorage.getItem(MERGE_ID_KEY);
  if (mergeId) {
    await fetch(`/api/merges/${mergeId}`, { method: 'DELETE' }).catch(() => {});
    localStorage.removeItem(MERGE_ID_KEY);
  }
  compareSession = null;
};

window._launchNewCompare = async function(imageHash, setIds) {
  const data = await fetch('/api/compare', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ imageHash, setIds }),
  }).then(r => r.json());

  const annotations = data.annotations.map((a, i) => ({ ...a, overlay: 'outline', num: i + 1 }));
  const annById = Object.fromEntries(annotations.map(a => [a.id, a]));
  let   pileCount = 0;
  const piles     = {};
  const pileIds   = [];
  for (const ids of data.piles) {
    const pid     = `P${++pileCount}`;
    const flagged = _isConflict(ids, setIds, annById);
    piles[pid] = {
      annotationIds: ids,
      collapsed:     !flagged,
      visible:       true,
      showBbox:      false,
      flagged,
      colors:        _makeColors(ids, annById),
    };
    pileIds.push(pid);
  }

  compareSession = {
    version:        1,
    imageHash,
    imageWidth:     data.imageWidth,
    imageHeight:    data.imageHeight,
    includedSetIds: setIds,
    phase:          'grouping',
    blind:          true,
    finalBlind:     true,
    globalColors:   _makeGlobalColors(setIds),
    annotations,
    edges:          data.edges || [],
    layers: [{ id: 'L1', name: 'Layer 1', collapsed: false, visible: true, piles: pileIds }],
    piles,
  };

  const mResp = await fetch('/api/merges', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ imageHash, doc: compareSession }),
  });
  if (mResp.ok) {
    const mData = await mResp.json();
    localStorage.setItem(MERGE_ID_KEY, mData.id);
  }

  showCompareGrouping();
};

/* ── Init ────────────────────────────────────────────────────────────────── */
function initCompareSetup() {
  // All setup UI is now in MergeScreen.tsx (Solid); bridge functions above
}
