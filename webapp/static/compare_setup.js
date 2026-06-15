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
  ['home-screen','manage-screen','fork-screen','config-screen','add-pair-screen',
   'compare-fork','compare-setup']
    .forEach(id => { document.getElementById(id).hidden = true; });
}

function showCompareFork(saved) {
  compareSession = saved;
  _hideAllSetupScreens();
  const imgPair = availablePairs.find(p => p.image_hash === saved.imageHash);
  const imgName = imgPair ? imgPair.display_name : saved.imageHash.slice(0, 8) + '…';
  const nPiles  = Object.keys(saved.piles).length;
  document.getElementById('compare-fork-info').innerHTML =
    `<strong>${imgName}</strong><br>` +
    `${saved.includedSetIds.length} annotation sets · ${nPiles} piles`;
  document.getElementById('compare-fork').hidden = false;
}

function showCompareSetup() {
  _hideAllSetupScreens();
  document.getElementById('compare-setup').hidden = false;
  _renderImageList();
}

/* ── Image + set picker ──────────────────────────────────────────────────── */
let _selectedImageHash = null;

function _renderImageList() {
  _selectedImageHash = null;
  document.getElementById('compare-continue-btn').disabled = true;
  document.getElementById('compare-sets-section').hidden   = true;

  const byHash = {};
  for (const p of availablePairs) {
    (byHash[p.image_hash] = byHash[p.image_hash] || []).push(p);
  }

  const list = document.getElementById('compare-image-list');
  list.innerHTML = '';

  if (!Object.keys(byHash).length) {
    const msg = document.createElement('p');
    msg.className   = 'pair-empty';
    msg.textContent = 'No annotation sets yet.';
    list.appendChild(msg);
    return;
  }

  for (const [hash, pairs] of Object.entries(byHash)) {
    const div  = document.createElement('div');
    div.className    = 'pair-item';
    div.dataset.hash = hash;
    const left = document.createElement('div');
    left.className = 'pair-item-left';
    left.innerHTML =
      `<strong class="pair-name">${pairs[0].display_name}</strong>` +
      `<span>${pairs.length} annotation set${pairs.length !== 1 ? 's' : ''}</span>`;
    div.appendChild(left);
    div.addEventListener('click', () => _selectImage(hash));
    list.appendChild(div);
  }
}

function _selectImage(hash) {
  _selectedImageHash = hash;
  document.querySelectorAll('#compare-image-list .pair-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.hash === hash);
  });
  _renderSetList(hash);
  document.getElementById('compare-sets-section').hidden = false;
  _updateContinueBtn();
}

function _renderSetList(hash) {
  const pairs = availablePairs.filter(p => p.image_hash === hash);
  const list  = document.getElementById('compare-set-list');
  list.innerHTML = '';
  for (const p of pairs) {
    const label = document.createElement('label');
    label.className = 'compare-set-row';
    const cb = document.createElement('input');
    cb.type    = 'checkbox';
    cb.checked = true;
    cb.dataset.id = p.id;
    cb.addEventListener('change', _updateContinueBtn);
    label.appendChild(cb);
    label.append(` ${p.display_name} (${_countLabel(p)})`);
    list.appendChild(label);
  }
}

function _updateContinueBtn() {
  const checked = document.querySelectorAll('#compare-set-list input:checked').length;
  document.getElementById('compare-continue-btn').disabled =
    !_selectedImageHash || checked === 0;
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

/* ── Init ────────────────────────────────────────────────────────────────── */
function initCompareSetup() {
  document.getElementById('compare-resume-btn').addEventListener('click', () => {
    if (!compareSession) return;
    showCompareGrouping();
  });

  document.getElementById('compare-new-btn').addEventListener('click', () => {
    compareSession = null;
    showCompareSetup();
  });

  document.getElementById('compare-delete-btn').addEventListener('click', () => {
    const mergeId = localStorage.getItem(MERGE_ID_KEY);
    if (mergeId) {
      fetch(`/api/merges/${mergeId}`, { method: 'DELETE' }).catch(() => {});
      localStorage.removeItem(MERGE_ID_KEY);
    }
    compareSession = null;
    showCompareSetup();
  });

  document.getElementById('home-btn-compare-fork').addEventListener('click',
    showHomeScreen);
  document.getElementById('home-btn-compare-setup').addEventListener('click',
    showHomeScreen);

  document.getElementById('compare-continue-btn').addEventListener('click', async () => {
    const setIds = [...document.querySelectorAll('#compare-set-list input:checked')]
                    .map(cb => cb.dataset.id);
    const btn = document.getElementById('compare-continue-btn');
    btn.disabled    = true;
    btn.textContent = 'Loading…';
    try {
      const data = await fetch('/api/compare', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ imageHash: _selectedImageHash, setIds }),
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
        imageHash:      _selectedImageHash,
        imageWidth:     data.imageWidth,
        imageHeight:    data.imageHeight,
        includedSetIds: setIds,
        phase:          'grouping',
        blind:          true,
        finalBlind:     true,
        globalColors:   _makeGlobalColors(setIds),
        annotations,
        edges:          data.edges || [],
        layers: [{
          id:        'L1',
          name:      'Layer 1',
          collapsed: false,
          visible:   true,
          piles:     pileIds,
        }],
        piles,
      };

      // Create server-side merge row and store its ID
      const mResp = await fetch('/api/merges', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ imageHash: _selectedImageHash, doc: compareSession }),
      });
      if (mResp.ok) {
        const mData = await mResp.json();
        localStorage.setItem(MERGE_ID_KEY, mData.id);
      }

      showCompareGrouping();
    } catch (e) {
      console.error('compare seeding failed', e);
      btn.textContent = 'Error — retry';
      btn.disabled    = false;
    }
  });
}
