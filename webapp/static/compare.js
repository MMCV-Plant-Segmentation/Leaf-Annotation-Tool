/* ── Compare grouping page ───────────────────────────────────────────────── */
const _selection = new Set();
let _filterHideNonConflict = false;
let _filterHideTrivial     = false;
let _autoResolveTrivial    = false;
let _lastClickedAnnId      = null;

function showCompareGrouping() {
  document.getElementById('setup-screen').hidden   = true;
  document.getElementById('compare-screen').hidden = false;
  _initCompareCanvas();
  _resizeCompareCanvas();
  _updatePhaseUI();
  overviewImg       = new Image();
  overviewImg.onload = () => { frameCompareUnion(); drawCompareCanvas(); };
  overviewImg.src    = `/api/image/${compareSession.imageHash}`;
  renderCompareTree();
}

/* ── Tree rendering ──────────────────────────────────────────────────────── */
function renderCompareTree() {
  const tree    = document.getElementById('compare-tree');
  tree.innerHTML = '';
  const annById  = Object.fromEntries(compareSession.annotations.map(a => [a.id, a]));
  const layers   = compareSession.layers;
  let   pileNum  = 0;

  const isFinalPage  = compareSession.phase === 'final';
  const totalPiles   = layers.reduce((s, l) => s + l.piles.length, 0);
  const flaggedCount = Object.values(compareSession.piles).filter(p => p.flagged).length;
  const statsEl = document.getElementById('compare-stats');
  if (statsEl) statsEl.textContent = isFinalPage
    ? `${totalPiles} pile${totalPiles !== 1 ? 's' : ''}`
    : `${totalPiles} pile${totalPiles !== 1 ? 's' : ''} · ${flaggedCount} conflict${flaggedCount !== 1 ? 's' : ''}`;
  document.getElementById('compare-done-btn').disabled = flaggedCount > 0;

  const isBlind  = isFinalPage ? !!compareSession.finalBlind : !!compareSession.blind;
  const blindBtn = document.getElementById('compare-blind-btn');
  if (blindBtn) {
    blindBtn.textContent = isBlind ? '🙈 Blind' : '👁 Blind';
    blindBtn.classList.toggle('active', isBlind);
  }

  const keyEl = document.getElementById('compare-color-key');
  if (keyEl) {
    keyEl.hidden = isBlind;
    if (!isBlind) {
      keyEl.innerHTML = compareSession.includedSetIds.map(sid => {
        const color = compareSession.globalColors?.[sid] || '#888';
        return `<div class="ck-row"><span class="ck-swatch" style="background:${color}"></span>${_setDisplayName(sid)}</div>`;
      }).join('');
    }
  }

  // ── Filter bar (grouping page only) ─────────────────────────────────────
  if (!isFinalPage) {
    const filterBar = document.createElement('div');
    filterBar.className = 'ct-filter-bar';

    const btnHideResolved = document.createElement('button');
    btnHideResolved.className = 'ct-filter-btn' + (_filterHideNonConflict ? ' active' : '');
    btnHideResolved.textContent = 'Hide resolved';
    btnHideResolved.title = 'Hide piles with no conflict flag';
    btnHideResolved.addEventListener('click', () => {
      _filterHideNonConflict = !_filterHideNonConflict;
      renderCompareTree(); drawCompareCanvas();
    });

    const missingGroup = document.createElement('div');
    missingGroup.className = 'ct-filter-group';

    const btnHideMissing = document.createElement('button');
    btnHideMissing.className = 'ct-filter-btn' + (_filterHideTrivial ? ' active' : '');
    btnHideMissing.textContent = 'Hide missing-only';
    btnHideMissing.title = 'Hide piles whose only conflict is that some annotators are absent';
    btnHideMissing.addEventListener('click', () => {
      _filterHideTrivial = !_filterHideTrivial;
      if (_filterHideTrivial) _autoResolveTrivial = false;
      renderCompareTree(); drawCompareCanvas();
    });

    const btnAutoResolve = document.createElement('button');
    btnAutoResolve.className = 'ct-filter-btn' + (_autoResolveTrivial ? ' active' : '');
    btnAutoResolve.textContent = 'Auto-resolve missing';
    btnAutoResolve.title = 'When on, newly split piles with only missing-annotator conflicts are auto-resolved';
    btnAutoResolve.addEventListener('click', () => {
      _autoResolveTrivial = !_autoResolveTrivial;
      if (_autoResolveTrivial) {
        _filterHideTrivial = false;
        for (const pile of Object.values(compareSession.piles)) {
          if (_isTrivialConflict(pile)) pile.flagged = false;
        }
        saveCompareSession(); drawCompareCanvas();
      }
      renderCompareTree();
    });

    missingGroup.append(btnHideMissing, btnAutoResolve);
    filterBar.append(btnHideResolved, missingGroup);
    tree.appendChild(filterBar);
  }

  // ── Layers / piles ──────────────────────────────────────────────────────
  layers.forEach((layer, li) => {
    tree.appendChild(_makeLayerRow(layer, li, layers));
    if (layer.collapsed) return;
    layer.piles.forEach((pileId, pi) => {
      pileNum++;
      const pile = compareSession.piles[pileId];
      if (pileId !== focusPileId && !isFinalPage) {
        if (_filterHideNonConflict && !pile.flagged) return;
        if (_filterHideTrivial && _isTrivialConflict(pile)) return;
      }
      const dim  = !!(focusPileId && focusPileId !== pileId);
      tree.appendChild(_makePileRow(pileId, pile, pileNum, dim, li, pi));
      if (pile.collapsed || dim) return;
      if (focusPileId === pileId) {
        for (const annId of pile.annotationIds) {
          tree.appendChild(_makeAnnRowCheck(annId, annById[annId], pile));
        }
        if (pile.annotationIds.length > 1 && !isFinalPage) tree.appendChild(_makeSplitRow());
      } else {
        for (const annId of pile.annotationIds) {
          tree.appendChild(_makeAnnRow(annById[annId], pile));
        }
      }
    });
  });

  const addBtn = document.createElement('button');
  addBtn.className   = 'ct-add-layer-btn';
  addBtn.textContent = '+ Add Layer';
  addBtn.addEventListener('click', _addLayer);
  tree.appendChild(addBtn);

  // Scroll focused pile or highlighted annotation into view
  requestAnimationFrame(() => {
    const target =
      (_lastClickedAnnId && tree.querySelector(`[data-ann-id="${_lastClickedAnnId}"]`)) ||
      (focusPileId       && tree.querySelector(`[data-pile-id="${focusPileId}"]`));
    if (target) target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
}

/* ── Row builders ────────────────────────────────────────────────────────── */
function _makeLayerRow(layer, li, layers) {
  const row = document.createElement('div');
  row.className = 'ct-layer-row';

  const caret = _makeCaretBtn(layer.collapsed, () => {
    layer.collapsed = !layer.collapsed;
    saveCompareSession(); renderCompareTree();
  });
  const label = document.createElement('span');
  label.className = 'ct-label'; label.textContent = layer.name;

  const eye = _makeEyeBtn(layer.visible, () => {
    layer.visible = !layer.visible;
    saveCompareSession(); renderCompareTree(); drawCompareCanvas();
  });
  const up = _makeArrowBtn('↑', li > 0, () => {
    [layers[li - 1], layers[li]] = [layers[li], layers[li - 1]];
    saveCompareSession(); renderCompareTree(); drawCompareCanvas();
  });
  const dn = _makeArrowBtn('↓', li < layers.length - 1, () => {
    [layers[li], layers[li + 1]] = [layers[li + 1], layers[li]];
    saveCompareSession(); renderCompareTree(); drawCompareCanvas();
  });
  const del = document.createElement('button');
  del.className = 'ct-icon-btn ct-del-btn'; del.textContent = '✕';
  del.title = 'Delete layer (must be empty)'; del.disabled = layer.piles.length > 0;
  del.addEventListener('click', () => {
    compareSession.layers = compareSession.layers.filter(l => l.id !== layer.id);
    saveCompareSession(); renderCompareTree(); drawCompareCanvas();
  });

  row.append(caret, label, eye, up, dn, del);
  return row;
}

function _makePileRow(pileId, pile, num, dim, li, pi) {
  const row = document.createElement('div');
  row.className = 'ct-pile-row' + (dim ? ' ct-dim' : '');
  row.dataset.pileId = pileId;

  const caret = _makeCaretBtn(pile.collapsed, () => {
    pile.collapsed = !pile.collapsed;
    saveCompareSession(); renderCompareTree();
  });
  const label = document.createElement('span');
  label.className = 'ct-label';
  const n        = pile.annotationIds.length;
  const pileWord = compareSession.phase === 'final' ? 'Lesion' : 'Pile';
  label.textContent = `${pileWord} ${num} · ${n} annotation${n !== 1 ? 's' : ''}`;

  const isFinal = compareSession.phase === 'final';
  const visBtn  = _makePileVisBtn(pile);

  const layers = compareSession.layers;
  const layer  = layers[li];
  const up = _makeArrowBtn('↑', pi > 0 || li > 0,
    () => _movePile(li, pi, -1));
  const dn = _makeArrowBtn('↓', pi < layer.piles.length - 1 || li < layers.length - 1,
    () => _movePile(li, pi,  1));

  if (isFinal) {
    let zoomBtn;
    if (focusPileId === pileId) {
      zoomBtn = document.createElement('button');
      zoomBtn.className = 'ct-icon-btn'; zoomBtn.textContent = '↩';
      zoomBtn.title = 'Zoom out';
      zoomBtn.addEventListener('click', zoomOutFromPile);
    } else {
      zoomBtn = document.createElement('button');
      zoomBtn.className = 'ct-icon-btn ct-zoom-btn'; zoomBtn.textContent = '🔍';
      zoomBtn.title = 'Zoom to pile'; zoomBtn.disabled = !!focusPileId;
      zoomBtn.addEventListener('click', () => zoomToPile(pileId));
    }
    row.append(caret, label, visBtn, zoomBtn, up, dn);
  } else {
    const flag = document.createElement('button');
    flag.className = 'ct-flag-btn' + (pile.flagged ? ' active' : '');
    flag.textContent = '!'; flag.title = 'Conflict flag';
    flag.addEventListener('click', () => {
      pile.flagged = !pile.flagged; saveCompareSession(); renderCompareTree(); drawCompareCanvas();
    });
    let zoomBtn;
    if (focusPileId === pileId) {
      zoomBtn = document.createElement('button');
      zoomBtn.className = 'ct-icon-btn'; zoomBtn.textContent = '↩';
      zoomBtn.title = 'Zoom out';
      zoomBtn.addEventListener('click', zoomOutFromPile);
    } else {
      zoomBtn = document.createElement('button');
      zoomBtn.className = 'ct-icon-btn ct-zoom-btn'; zoomBtn.textContent = '🔍';
      zoomBtn.title = 'Zoom to pile'; zoomBtn.disabled = !!focusPileId;
      zoomBtn.addEventListener('click', () => zoomToPile(pileId));
    }
    row.append(caret, label, visBtn, flag, zoomBtn, up, dn);
  }
  return row;
}

function _applySwatchStyle(swatch, color, overlay) {
  if (overlay === 'full') {
    swatch.style.background = color; swatch.style.border = ''; swatch.style.opacity = '';
  } else if (overlay === 'outline') {
    swatch.style.background = 'transparent'; swatch.style.border = `2px solid ${color}`; swatch.style.opacity = '';
  } else {
    swatch.style.background = 'transparent'; swatch.style.border = `1px dashed ${color}`; swatch.style.opacity = '0.35';
  }
}

const _ANN_CYCLE = ['outline', 'full', 'none'];

function _makeAnnRow(ann, pile) {
  const num = ann.num;
  const row = document.createElement('div');
  row.className = 'ct-ann-row'; row.style.cursor = 'pointer';
  row.dataset.annId = ann.id;
  if (_selection.has(ann.id)) row.classList.add('ct-ann-highlighted');
  const ov    = ann.overlay || 'outline';
  const color = _annColor(pile, ann.setId);
  const swatch = document.createElement('span');
  swatch.className = 'ct-swatch'; swatch.style.cursor = 'pointer';
  _applySwatchStyle(swatch, color, ov);
  swatch.addEventListener('click', e => {
    e.stopPropagation();
    ann.overlay = _ANN_CYCLE[(_ANN_CYCLE.indexOf(ann.overlay || 'outline') + 1) % _ANN_CYCLE.length];
    saveCompareSession(); renderCompareTree(); drawCompareCanvas();
  });
  const label = document.createElement('span');
  label.textContent = `${num}`;
  if (ov === 'none') label.style.opacity = '0.4';
  row.addEventListener('click', e => {
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      if (_selection.has(ann.id)) _selection.delete(ann.id); else _selection.add(ann.id);
      _lastClickedAnnId = ann.id;
    } else {
      if (_selection.size === 1 && _selection.has(ann.id)) {
        _selection.clear(); _lastClickedAnnId = null;
      } else {
        _selection.clear(); _selection.add(ann.id); _lastClickedAnnId = ann.id;
      }
    }
    renderCompareTree(); drawCompareCanvas();
  });
  row.append(swatch, label);
  return row;
}

function _makeAnnRowCheck(annId, ann, pile) {
  const num = ann.num;
  const row = document.createElement('div');
  row.className = 'ct-ann-row'; row.style.cursor = 'pointer';
  row.dataset.annId = annId;
  if (_selection.has(annId)) row.classList.add('ct-ann-highlighted');
  const ov    = ann.overlay || 'outline';
  const color = _annColor(pile, ann.setId);
  const swatch = document.createElement('span');
  swatch.className = 'ct-swatch'; swatch.style.cursor = 'pointer';
  _applySwatchStyle(swatch, color, ov);
  swatch.addEventListener('click', e => {
    e.stopPropagation();
    ann.overlay = _ANN_CYCLE[(_ANN_CYCLE.indexOf(ann.overlay || 'outline') + 1) % _ANN_CYCLE.length];
    saveCompareSession(); renderCompareTree(); drawCompareCanvas();
  });
  const label = document.createElement('span');
  label.textContent = `${num}`;
  if (ov === 'none') label.style.opacity = '0.4';
  row.addEventListener('click', e => {
    _applyFocusClick(annId, pile, e.shiftKey, e.ctrlKey || e.metaKey);
  });
  row.append(swatch, label);
  return row;
}

/* ── Conflict helpers ─────────────────────────────────────────────────────── */
function _isTrivialConflict(pile) {
  if (!pile.flagged) return false;
  const annById = Object.fromEntries(compareSession.annotations.map(a => [a.id, a]));
  const counts = {};
  for (const id of pile.annotationIds) {
    const sid = annById[id].setId;
    counts[sid] = (counts[sid] || 0) + 1;
  }
  const vals = Object.values(counts);
  return vals.length > 0 && vals.every(v => v === vals[0]);
}

/* ── Canvas click ─────────────────────────────────────────────────────────── */
function _pointInPoly(px, py, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i][0], yi = points[i][1];
    const xj = points[j][0], yj = points[j][1];
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

function _handleCanvasClick(worldX, worldY, shiftKey, ctrlKey) {
  const annById = Object.fromEntries(compareSession.annotations.map(a => [a.id, a]));
  let hitAnnId = null;

  if (focusPileId) {
    const pile = compareSession.piles[focusPileId];
    if (pile) {
      for (let i = pile.annotationIds.length - 1; i >= 0; i--) {
        const annId = pile.annotationIds[i];
        const ann   = annById[annId];
        if (ann.overlay === 'none') continue;
        if (_pointInPoly(worldX, worldY, ann.points)) { hitAnnId = annId; break; }
      }
    }
    _applyFocusClick(hitAnnId, compareSession.piles[focusPileId], shiftKey, ctrlKey);
  } else {
    outer: for (let li = compareSession.layers.length - 1; li >= 0; li--) {
      const layer = compareSession.layers[li];
      if (!layer.visible) continue;
      for (let pi = layer.piles.length - 1; pi >= 0; pi--) {
        const pileId = layer.piles[pi];
        const pile   = compareSession.piles[pileId];
        if (!pile.visible) continue;
        if (compareSession.phase !== 'final' && _filterHideNonConflict && !pile.flagged) continue;
        if (compareSession.phase !== 'final' && _filterHideTrivial && _isTrivialConflict(pile)) continue;
        for (let i = pile.annotationIds.length - 1; i >= 0; i--) {
          const annId = pile.annotationIds[i];
          const ann   = annById[annId];
          if (ann.overlay === 'none') continue;
          if (_pointInPoly(worldX, worldY, ann.points)) { hitAnnId = annId; break outer; }
        }
      }
    }
    if (hitAnnId) {
      // Expand the containing pile if collapsed so the annotation is visible in the sidebar
      const hitPile = Object.values(compareSession.piles).find(p => p.annotationIds.includes(hitAnnId));
      if (hitPile && hitPile.collapsed) { hitPile.collapsed = false; saveCompareSession(); }
      if (ctrlKey || shiftKey) {
        if (_selection.has(hitAnnId)) _selection.delete(hitAnnId);
        else _selection.add(hitAnnId);
        _lastClickedAnnId = hitAnnId;
      } else {
        if (_selection.size === 1 && _selection.has(hitAnnId)) {
          _selection.clear(); _lastClickedAnnId = null;
        } else {
          _selection.clear(); _selection.add(hitAnnId); _lastClickedAnnId = hitAnnId;
        }
      }
    } else {
      _selection.clear(); _lastClickedAnnId = null;
    }
    drawCompareCanvas(); renderCompareTree();
  }
}

function _applyFocusClick(annId, pile, shiftKey, ctrlKey) {
  if (annId) {
    const ids = pile.annotationIds;
    if (shiftKey && _lastClickedAnnId && ids.includes(_lastClickedAnnId)) {
      const a = ids.indexOf(_lastClickedAnnId), b = ids.indexOf(annId);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      for (let i = lo; i <= hi; i++) _selection.add(ids[i]);
    } else if (ctrlKey) {
      if (_selection.has(annId)) _selection.delete(annId); else _selection.add(annId);
      _lastClickedAnnId = annId;
    } else {
      if (_selection.size === 1 && _selection.has(annId)) {
        _selection.clear(); _lastClickedAnnId = null;
      } else {
        _selection.clear(); _selection.add(annId); _lastClickedAnnId = annId;
      }
    }
  } else {
    _selection.clear(); _lastClickedAnnId = null;
  }
  _updateSplitBtn(); drawCompareCanvas(); renderCompareTree();
}

function _makeSplitRow() {
  const pile = compareSession.piles[focusPileId];
  const row  = document.createElement('div');
  row.className = 'ct-split-row';

  const controls = document.createElement('div');
  controls.className = 'ct-split-controls';

  const btn = document.createElement('button');
  btn.id = 'compare-split-btn'; btn.className = 'btn-secondary';
  btn.textContent = 'Split Off';
  btn.style.cssText = 'font-size:0.72rem;padding:4px 10px;white-space:nowrap;flex:0 0 auto';
  btn.addEventListener('click', splitPile);

  const select = document.createElement('select');
  select.id = 'compare-split-layer-select';
  select.style.cssText = 'font-size:0.7rem;flex:1;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:2px 4px';
  const currentLayerId = compareSession.layers.find(l => l.piles.includes(focusPileId))?.id;
  for (const l of compareSession.layers) {
    const opt = document.createElement('option');
    opt.value = l.id; opt.textContent = l.name;
    if (l.id === currentLayerId) opt.selected = true;
    select.appendChild(opt);
  }
  const newOpt = document.createElement('option');
  newOpt.value = '__new__'; newOpt.textContent = '+ New Layer';
  select.appendChild(newOpt);

  const hint = document.createElement('span');
  hint.id = 'compare-split-hint'; hint.className = 'ct-split-hint';

  const sel = [..._selection].filter(id => pile.annotationIds.includes(id));
  const connected = sel.length > 0 &&
    sel.length < pile.annotationIds.length &&
    _connectedComponents(sel).length === 1;
  btn.disabled = !connected;
  hint.textContent = connected ? '' :
    sel.length === 0 ? 'Select annotations to split off' :
    sel.length >= pile.annotationIds.length ? 'Must keep at least one annotation' :
    'Selection must be a single connected component';

  controls.append(btn, select);
  row.append(controls, hint);
  return row;
}

/* ── Connected components (client-side union-find using stored edges) ─────── */
function _connectedComponents(annIds) {
  const idSet  = new Set(annIds);
  const parent = Object.fromEntries(annIds.map(id => [id, id]));
  function find(x) {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  }
  for (const [a, b] of (compareSession.edges || [])) {
    if (idSet.has(a) && idSet.has(b)) {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    }
  }
  const groups = {};
  for (const id of annIds) {
    const root = find(id);
    (groups[root] = groups[root] || []).push(id);
  }
  return Object.values(groups);
}

function _updateSplitBtn() {
  const btn  = document.getElementById('compare-split-btn');
  const hint = document.getElementById('compare-split-hint');
  if (!btn) return;
  const pile = compareSession.piles[focusPileId];
  if (!pile) return;
  const sel = [..._selection].filter(id => pile.annotationIds.includes(id));
  const connected = sel.length > 0 &&
    sel.length < pile.annotationIds.length &&
    _connectedComponents(sel).length === 1;
  btn.disabled = !connected;
  const msg = connected ? '' :
    sel.length === 0 ? 'Select annotations to split off' :
    sel.length >= pile.annotationIds.length ? 'Must keep at least one annotation' :
    'Selection must be a single connected component';
  if (hint) hint.textContent = msg;
}

/* ── Split ───────────────────────────────────────────────────────────────── */
function splitPile() {
  const pile = compareSession.piles[focusPileId];
  if (!pile) return;
  const selected  = [..._selection].filter(id => pile.annotationIds.includes(id));
  const remaining = pile.annotationIds.filter(id => !selected.includes(id));
  if (selected.length === 0 || selected.length >= pile.annotationIds.length) return;

  const annById = Object.fromEntries(compareSession.annotations.map(a => [a.id, a]));

  // Resolve target layer (create new if requested)
  const selectEl = document.getElementById('compare-split-layer-select');
  let targetLayerId = selectEl ? selectEl.value : compareSession.layers[0]?.id;
  if (targetLayerId === '__new__') {
    const maxL = compareSession.layers
      .map(l => parseInt(l.id.slice(1), 10)).reduce((a, b) => Math.max(a, b), 0);
    targetLayerId = `L${maxL + 1}`;
    compareSession.layers.push({
      id: targetLayerId, name: `Layer ${compareSession.layers.length + 1}`,
      collapsed: false, visible: true, piles: [],
    });
  }

  let maxN = Object.keys(compareSession.piles)
    .map(id => parseInt(id.slice(1), 10)).reduce((a, b) => Math.max(a, b), 0);

  // Create the split-off pile (selected annotations → target layer)
  const newPileId = `P${++maxN}`;
  compareSession.piles[newPileId] = {
    annotationIds: selected,
    collapsed:     false,
    visible:       true,
    showBbox:      false,
    flagged:       _isConflict(selected, compareSession.includedSetIds, annById),
    colors:        _makeColors(selected, annById),
  };
  if (_autoResolveTrivial && _isTrivialConflict(compareSession.piles[newPileId]))
    compareSession.piles[newPileId].flagged = false;
  const targetLayer = compareSession.layers.find(l => l.id === targetLayerId);
  if (targetLayer) targetLayer.piles.push(newPileId);

  // Recompute connected components for remaining annotations
  const originalLayer = compareSession.layers.find(l => l.piles.includes(focusPileId));
  const originalIndex = originalLayer ? originalLayer.piles.indexOf(focusPileId) : -1;
  const remainComps   = remaining.length > 0 ? _connectedComponents(remaining) : [];

  if (remainComps.length === 0) {
    delete compareSession.piles[focusPileId];
    if (originalLayer && originalIndex >= 0) originalLayer.piles.splice(originalIndex, 1);
  } else if (remainComps.length === 1) {
    pile.annotationIds = remaining;
    pile.colors  = _makeColors(remaining, annById);
    pile.flagged = _isConflict(remaining, compareSession.includedSetIds, annById);
    if (_autoResolveTrivial && _isTrivialConflict(pile)) pile.flagged = false;
  } else {
    // First component replaces the original pile; extras become new piles in the same layer
    pile.annotationIds = remainComps[0];
    pile.colors  = _makeColors(remainComps[0], annById);
    pile.flagged = _isConflict(remainComps[0], compareSession.includedSetIds, annById);
    if (_autoResolveTrivial && _isTrivialConflict(pile)) pile.flagged = false;
    const shardIds = [];
    for (let i = 1; i < remainComps.length; i++) {
      const shardId = `P${++maxN}`;
      compareSession.piles[shardId] = {
        annotationIds: remainComps[i],
        collapsed:     false,
        visible:       true,
        showBbox:      false,
        flagged:       _isConflict(remainComps[i], compareSession.includedSetIds, annById),
        colors:        _makeColors(remainComps[i], annById),
      };
      if (_autoResolveTrivial && _isTrivialConflict(compareSession.piles[shardId]))
        compareSession.piles[shardId].flagged = false;
      shardIds.push(shardId);
    }
    if (originalLayer && originalIndex >= 0)
      originalLayer.piles.splice(originalIndex + 1, 0, ...shardIds);
  }

  focusPileId = newPileId;
  if (targetLayer) targetLayer.collapsed = false;
  _selection.clear();
  saveCompareSession();
  _reframeFocusedPile();
  renderCompareTree();
}

/* ── Layer management ────────────────────────────────────────────────────── */
function _addLayer() {
  const maxN = compareSession.layers
    .map(l => parseInt(l.id.slice(1), 10))
    .reduce((a, b) => Math.max(a, b), 0);
  compareSession.layers.push({
    id:        `L${maxN + 1}`,
    name:      `Layer ${compareSession.layers.length + 1}`,
    collapsed: false,
    visible:   true,
    piles:     [],
  });
  saveCompareSession(); renderCompareTree();
}

function _movePile(li, pi, dir) {
  const layers = compareSession.layers;
  const layer  = layers[li];
  const pileId = layer.piles[pi];
  if (dir === -1) {
    if (pi > 0) {
      [layer.piles[pi - 1], layer.piles[pi]] = [layer.piles[pi], layer.piles[pi - 1]];
    } else if (li > 0) {
      layer.piles.splice(pi, 1);
      layers[li - 1].piles.push(pileId);
    }
  } else {
    if (pi < layer.piles.length - 1) {
      [layer.piles[pi], layer.piles[pi + 1]] = [layer.piles[pi + 1], layer.piles[pi]];
    } else if (li < layers.length - 1) {
      layer.piles.splice(pi, 1);
      layers[li + 1].piles.unshift(pileId);
    }
  }
  saveCompareSession(); renderCompareTree(); drawCompareCanvas();
}

/* ── Button helpers ──────────────────────────────────────────────────────── */
function _makeCaretBtn(collapsed, onClick) {
  const btn = document.createElement('button');
  btn.className = 'ct-caret-btn'; btn.textContent = collapsed ? '▶' : '▼';
  btn.addEventListener('click', onClick);
  return btn;
}

function _makeArrowBtn(text, enabled, onClick) {
  const btn = document.createElement('button');
  btn.className = 'ct-icon-btn ct-arrow-btn'; btn.textContent = text;
  btn.disabled  = !enabled;
  btn.addEventListener('click', onClick);
  return btn;
}

function _makeEyeBtn(visible, onClick) {
  const btn = document.createElement('button');
  btn.className = 'ct-icon-btn' + (visible ? '' : ' ct-off');
  btn.textContent = '👁'; btn.title = visible ? 'Hide' : 'Show';
  btn.addEventListener('click', onClick);
  return btn;
}

function _makePileVisBtn(pile) {
  const btn = document.createElement('button');
  btn.className = 'ct-icon-btn';
  btn.textContent = '👁';
  if (!pile.visible) {
    btn.classList.add('ct-off');
    btn.title = 'Show';
  } else if (pile.showBbox) {
    btn.classList.add('ct-bbox-on');
    btn.title = 'Hide bounding box';
  } else {
    btn.title = 'Hide';
  }
  btn.addEventListener('click', () => {
    if (pile.visible && !pile.showBbox) {
      pile.visible = false;
    } else if (!pile.visible) {
      pile.visible = true; pile.showBbox = true;
    } else {
      pile.showBbox = false;
    }
    saveCompareSession(); renderCompareTree(); drawCompareCanvas();
  });
  return btn;
}


function _setDisplayName(setId) {
  const p = availablePairs.find(q => q.id === setId);
  return p ? p.display_name : setId.slice(0, 8) + '…';
}

function _annColor(pile, setId) {
  const isBlind = compareSession.phase === 'final' ? !!compareSession.finalBlind : !!compareSession.blind;
  return isBlind ? (pile.colors[setId] || '#888') : (compareSession.globalColors?.[setId] || '#888');
}

/* ── Phase UI ────────────────────────────────────────────────────────────── */
function _updatePhaseUI() {
  const isFinal = compareSession.phase === 'final';
  document.getElementById('compare-done-btn').hidden  =  isFinal;
  document.getElementById('compare-back-btn').hidden  = !isFinal;
  document.getElementById('compare-page-title').textContent =
    isFinal ? 'Compare Lesions' : 'Group Distinct Lesions';
}

/* ── Init ────────────────────────────────────────────────────────────────── */
function initCompare() {
  document.getElementById('compare-done-btn').addEventListener('click', () => {
    compareSession.phase = 'final';
    Object.values(compareSession.piles).forEach(p => { p.showBbox = true; });
    focusPileId = null; _cCropImg = null; cropBbox = null;
    _selection.clear(); _lastClickedAnnId = null;
    saveCompareSession();
    _updatePhaseUI();
    renderCompareTree();
    drawCompareCanvas();
  });
  document.getElementById('compare-back-btn').addEventListener('click', () => {
    compareSession.phase = 'grouping';
    focusPileId = null; _cCropImg = null; cropBbox = null;
    _selection.clear(); _lastClickedAnnId = null;
    saveCompareSession();
    _updatePhaseUI();
    renderCompareTree();
    drawCompareCanvas();
  });
  document.getElementById('compare-blind-btn').addEventListener('click', () => {
    if (compareSession.phase === 'final') {
      compareSession.finalBlind = !compareSession.finalBlind;
    } else {
      compareSession.blind = !compareSession.blind;
    }
    saveCompareSession(); renderCompareTree(); drawCompareCanvas();
  });
  document.getElementById('compare-home-btn').addEventListener('click', () => {
    document.getElementById('compare-screen').hidden = true;
    document.getElementById('setup-screen').hidden   = false;
    showHomeScreen();
  });
  window.addEventListener('resize', () => {
    if (document.getElementById('compare-screen').hidden) return;
    _resizeCompareCanvas(); drawCompareCanvas();
  });
}
