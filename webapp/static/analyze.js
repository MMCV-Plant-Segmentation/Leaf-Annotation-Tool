/* ── Analyze state ────────────────────────────────────────────────────────── */
let analyzeData           = null;
let analyzeImg            = null;
let analyzeSelectedId     = null;
let analyzeBbox           = true;
let analyzeBlind          = false;
let analyzeAnnotColor     = '#4a9eff';
let analyzeAnnotOpacity   = 0.50;
let analyzeMode           = 'absolute';   // 'absolute' | 'relative'
let analyzeSelectedPile   = null;
let analyzeDetailK        = null;   // which k bar is expanded in sidebar (independent of slider)
let analyzeVisiblePiles   = [];
let analyzeSourceIds      = [];
let analyzeSourceColorMap = {};
let analyzeSourceNameMap  = {};     // sourceId → display name
const aView = { zoom: 1, viewX: 0, viewY: 0 };

const _SRC_COLORS = ['#ff6b6b', '#51cf66', '#ffd43b', '#74c0fc', '#f783ac', '#a9e34b'];

function _hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function _polygonArea(rings) {
  let total = 0;
  for (const ring of rings) {
    let area = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      area += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    }
    total += Math.abs(area) / 2;
  }
  return total;
}

/* Ray-casting point-in-polygon for world-space rings */
function _ptInRing(px, py, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

function _effectiveKAgree(kAgree, pileM) {
  if (analyzeMode === 'absolute') return kAgree;
  // relative: kAgree is 1..100 percentage; map to ceil(pct/100 * pile.m), min 1
  return Math.max(1, Math.ceil(kAgree / 100 * pileM));
}

function _updateKSliderFill() {
  const slider = document.getElementById('analyze-agree-k-slider');
  if (!slider) return;
  const val = +slider.value, min = +slider.min || 0, max = +slider.max || 1;
  const pct = max > min ? ((val - min) / (max - min)) * 100 : 100;
  const left = pct.toFixed(1) + '%';
  const dim  = _hexToRgba(analyzeAnnotColor, 0.35);
  const full = _hexToRgba(analyzeAnnotColor, 1.0);
  // Two layers: fixed dim→full gradient (bottom) + surface-color mask left of thumb (top)
  slider.style.background = [
    `linear-gradient(to right, var(--border) ${left}, transparent ${left})`,
    `linear-gradient(to right, ${dim} 0%, ${full} 100%)`
  ].join(', ');
}

function _updateKBreakdown() {
  const el       = document.getElementById('analyze-agree-k-breakdown');
  const labelsEl = document.getElementById('analyze-agree-k-labels');
  if (!el) return;
  if (!analyzeData) {
    el.hidden = true;
    if (labelsEl) labelsEl.hidden = true;
    return;
  }
  el.hidden = false;
  el.innerHTML = '';
  if (labelsEl) {
    labelsEl.hidden = false;
    labelsEl.innerHTML = '';
    const spacer = document.createElement('div');
    spacer.className = 'k-bd-spacer';
    labelsEl.appendChild(spacer);
  }

  const sliderVal = parseInt(document.getElementById('analyze-agree-k-slider').value) || 0;
  const mTotal    = analyzeData.mTotal;

  for (let mi = 1; mi <= mTotal; mi++) {
    const ek = analyzeMode === 'relative'
      ? (sliderVal === 0 ? 0 : Math.max(1, Math.ceil(sliderVal / 100 * mi)))
      : sliderVal;

    if (labelsEl) {
      const lbl = document.createElement('div');
      lbl.className   = 'k-bd-left-label';
      lbl.textContent = `m=${mi}`;
      labelsEl.appendChild(lbl);
    }

    const bar = document.createElement('div');
    bar.className = 'k-bd-bar';

    for (let k = 1; k <= mi; k++) {
      const seg = document.createElement('div');
      seg.className = 'k-bd-seg';
      const active = ek === 0 || k >= ek;
      seg.style.background = active
        ? _hexToRgba(analyzeAnnotColor,
            Math.min(1, (analyzeMode === 'absolute' ? k / mTotal : k / mi) * analyzeAnnotOpacity))
        : 'rgba(255,255,255,0.07)';
      bar.appendChild(seg);
    }

    el.appendChild(bar);
  }
  _updateKSliderFill();
}

/* ── Canvas setup ─────────────────────────────────────────────────────────── */
function _initAnalyzeCanvas() {
  const cv = document.getElementById('analyze-canvas');
  let dragging = false, lastX = 0, lastY = 0, dragMoved = false;
  cv.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    dragging = true; dragMoved = false; lastX = e.clientX; lastY = e.clientY;
    cv.style.cursor = 'grabbing';
  });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const dpr = window.devicePixelRatio || 1;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragMoved = true;
    aView.viewX -= dx * dpr / aView.zoom;
    aView.viewY -= dy * dpr / aView.zoom;
    lastX = e.clientX; lastY = e.clientY;
    _drawAnalyzeCanvas();
  });
  window.addEventListener('mouseup', e => {
    if (!dragging || e.button !== 0) return;
    dragging = false;
    cv.style.cursor = 'grab';
  });
  cv.addEventListener('click', e => {
    if (!analyzeData || dragMoved) return;
    const r   = cv.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const wx  = aView.viewX + (e.clientX - r.left) * dpr / aView.zoom;
    const wy  = aView.viewY + (e.clientY - r.top)  * dpr / aView.zoom;
    // Hit-test against actual polygon rings; sort by bbox area so smaller piles
    // (visually on top) take priority when annotations overlap.
    // Lower pile.id = earlier in the merge, treated as "on top"
    const hits = analyzeVisiblePiles
      .filter(pile => pile.sourceRings.some(src => src.rings.some(ring => _ptInRing(wx, wy, ring))))
      .sort((a, b) => a.id - b.id);
    const hit = hits.length ? hits[0].id : null;
    const pileChanged = hit !== analyzeSelectedPile;
    analyzeSelectedPile = (hit === analyzeSelectedPile) ? null : hit;
    if (pileChanged) {
      analyzeDetailK = null;
      const selPile = analyzeVisiblePiles.find(p => p.id === analyzeSelectedPile) ?? null;
      _renderAnalyzePileDetail(selPile);
      const kAgree  = parseInt(document.getElementById('analyze-agree-k-slider').value);
      const detailK = analyzeDetailK ?? (selPile ? _effectiveKAgree(kAgree, selPile.m) : kAgree);
      _renderAnalyzeKDetail(selPile, detailK);
    }
    _drawAnalyzeCanvas();
  });
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    const r  = cv.getBoundingClientRect();
    const sx = (e.clientX - r.left) * (cv.width / r.width);
    const sy = (e.clientY - r.top)  * (cv.height / r.height);
    const wx = aView.viewX + sx / aView.zoom;
    const wy = aView.viewY + sy / aView.zoom;
    const f  = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    aView.zoom  *= f;
    aView.viewX  = wx - sx / aView.zoom;
    aView.viewY  = wy - sy / aView.zoom;
    _drawAnalyzeCanvas();
  }, { passive: false });
}

function _resizeAnalyzeCanvas() {
  const cv  = document.getElementById('analyze-canvas');
  const dpr = window.devicePixelRatio || 1;
  cv.width  = Math.round((cv.clientWidth  || cv.offsetWidth)  * dpr);
  cv.height = Math.round((cv.clientHeight || cv.offsetHeight) * dpr);
  _drawAnalyzeCanvas();
}

function _frameAnalyzeUnion() {
  if (!analyzeData || !analyzeData.piles.length) return;
  const cv = document.getElementById('analyze-canvas');
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const pile of analyzeData.piles) {
    const [bx0, by0, bx1, by1] = pile.bbox;
    x0 = Math.min(x0, bx0); y0 = Math.min(y0, by0);
    x1 = Math.max(x1, bx1); y1 = Math.max(y1, by1);
  }
  if (x0 === Infinity) return;
  const bw = x1 - x0, bh = y1 - y0;
  const px0 = Math.max(0, x0 - bw * 0.1);
  const py0 = Math.max(0, y0 - bh * 0.1);
  const pw  = Math.min(analyzeData.imageWidth,  x1 + bw * 0.1) - px0;
  const ph  = Math.min(analyzeData.imageHeight, y1 + bh * 0.1) - py0;
  if (!cv.width || !pw || !ph) return;
  aView.zoom  = Math.min(cv.width / pw, cv.height / ph) * 0.9;
  aView.viewX = (px0 + pw / 2) - cv.width  / 2 / aView.zoom;
  aView.viewY = (py0 + ph / 2) - cv.height / 2 / aView.zoom;
}

/* ── Drawing ──────────────────────────────────────────────────────────────── */
function _drawAnalyzeCanvas() {
  const cv  = document.getElementById('analyze-canvas');
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = '#0d0f13';
  ctx.fillRect(0, 0, cv.width, cv.height);
  if (!analyzeData) return;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (analyzeImg && analyzeImg.complete && analyzeImg.naturalWidth) {
    ctx.drawImage(analyzeImg,
      -aView.viewX * aView.zoom,
      -aView.viewY * aView.zoom,
      analyzeData.imageWidth  * aView.zoom,
      analyzeData.imageHeight * aView.zoom,
    );
  }

  const k        = parseInt(document.getElementById('analyze-agree-slider').value);
  const kAgree   = parseInt(document.getElementById('analyze-agree-k-slider').value);
  const iouFilter = parseInt(document.getElementById('analyze-iou-slider').value) / 100;
  const dpr       = window.devicePixelRatio || 1;

  analyzeVisiblePiles = [];
  let visible = 0, filtered = 0, totalFraction = 0;
  for (const pile of analyzeData.piles) {
    if (pile.m < k) { filtered++; continue; }

    let fraction = 1;
    if (kAgree > 0) {
      const lookupK = _effectiveKAgree(kAgree, pile.m);
      const entry   = pile.agreementByK[String(lookupK)];
      fraction = entry ? entry.fraction : 0;
      if (fraction < iouFilter) { filtered++; continue; }
      totalFraction += fraction;
    }

    visible++;
    analyzeVisiblePiles.push(pile);
    const selected = pile.id === analyzeSelectedPile;

    // Footprints
    const _fillRing = ring => {
      if (ring.length < 2) return;
      ctx.beginPath();
      ctx.moveTo((ring[0][0] - aView.viewX) * aView.zoom, (ring[0][1] - aView.viewY) * aView.zoom);
      for (let i = 1; i < ring.length; i++)
        ctx.lineTo((ring[i][0] - aView.viewX) * aView.zoom, (ring[i][1] - aView.viewY) * aView.zoom);
      ctx.closePath();
      ctx.fill();
    };
    {
      // Both modes use delta-alpha ring stacking via agreementByK.
      // Absolute: step = T/mTotal  → full consensus pile reaches T; partial piles top out at pile.m/mTotal × T
      // Relative: step = T/pile.m  → every pile reaches T regardless of how many annotators drew it
      const step = analyzeAnnotOpacity / (analyzeMode === 'absolute' ? analyzeData.mTotal : pile.m);
      for (let ki = 1; ki <= pile.m; ki++) {
        const entry = pile.agreementByK[String(ki)];
        if (!entry) continue;
        const drawAlpha = step / (1 - (ki - 1) * step);
        ctx.fillStyle = _hexToRgba(analyzeAnnotColor, Math.min(1, selected ? Math.min(1, drawAlpha * 1.4) : drawAlpha));
        for (const ring of entry.rings) _fillRing(ring);
      }
    }

    // Bounding box
    if (analyzeBbox) {
      const [bx0, by0, bx1, by1] = pile.bbox;
      ctx.save();
      ctx.strokeStyle = selected ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.45)';
      ctx.lineWidth   = (selected ? 1.5 : 1) * dpr;
      ctx.setLineDash([4 * dpr, 4 * dpr]);
      ctx.strokeRect(
        (bx0 - aView.viewX) * aView.zoom,
        (by0 - aView.viewY) * aView.zoom,
        (bx1 - bx0) * aView.zoom,
        (by1 - by0) * aView.zoom,
      );
      ctx.restore();
    }

    // IoU label at bbox center
    const iouLabel = Math.round(fraction * 100) + '%';
    const cx = ((pile.bbox[0] + pile.bbox[2]) / 2 - aView.viewX) * aView.zoom;
    const cy = ((pile.bbox[1] + pile.bbox[3]) / 2 - aView.viewY) * aView.zoom;
    ctx.save();
    ctx.font         = `bold ${11 * dpr}px system-ui`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth    = 3 * dpr;
    ctx.strokeStyle  = 'rgba(0,0,0,0.75)';
    ctx.strokeText(iouLabel, cx, cy);
    ctx.fillStyle    = selected ? '#ffd43b' : 'rgba(255,255,255,0.9)';
    ctx.fillText(iouLabel, cx, cy);
    ctx.restore();

    // Selection: per-source outlines (colored unless blind mode)
    if (selected) {
      pile.sourceRings.forEach(src => {
        const color = analyzeBlind
          ? 'rgba(255,255,255,0.85)'
          : (analyzeSourceColorMap[src.sourceId] || '#ffffff');
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth   = 2 * dpr;
        ctx.setLineDash([]);
        for (const ring of src.rings) {
          if (ring.length < 2) continue;
          ctx.beginPath();
          ctx.moveTo(
            (ring[0][0] - aView.viewX) * aView.zoom,
            (ring[0][1] - aView.viewY) * aView.zoom,
          );
          for (let i = 1; i < ring.length; i++) {
            ctx.lineTo(
              (ring[i][0] - aView.viewX) * aView.zoom,
              (ring[i][1] - aView.viewY) * aView.zoom,
            );
          }
          ctx.closePath();
          ctx.stroke();
        }
        ctx.restore();
      });

      // I/U overlay — always shown for selected pile, using kAgree from slider
      {
        const drawRings = (rings, fn) => {
          for (const ring of rings) {
            if (ring.length < 2) continue;
            ctx.beginPath();
            ctx.moveTo((ring[0][0] - aView.viewX) * aView.zoom, (ring[0][1] - aView.viewY) * aView.zoom);
            for (let i = 1; i < ring.length; i++)
              ctx.lineTo((ring[i][0] - aView.viewX) * aView.zoom, (ring[i][1] - aView.viewY) * aView.zoom);
            ctx.closePath();
            fn();
          }
        };
        const uEntry = pile.agreementByK['1'];
        if (uEntry) {
          ctx.save();
          ctx.strokeStyle = 'rgba(255,255,255,0.55)';
          ctx.lineWidth   = 1.5 * dpr;
          ctx.setLineDash([3 * dpr, 4 * dpr]);
          drawRings(uEntry.rings, () => ctx.stroke());
          ctx.restore();
        }
        const overlayK = _effectiveKAgree(kAgree, pile.m);
        const iEntry   = overlayK > 0 ? pile.agreementByK[String(overlayK)] : null;
        if (iEntry) {
          ctx.save();
          ctx.fillStyle   = 'rgba(255,212,59,0.35)';
          ctx.strokeStyle = 'rgba(255,212,59,0.9)';
          ctx.lineWidth   = 2 * dpr;
          ctx.setLineDash([]);
          drawRings(iEntry.rings, () => { ctx.fill(); ctx.stroke(); });
          ctx.restore();
        }
      }
    }
  }

  // Legend (top-left canvas overlay, only when a pile is selected and not blind)
  if (analyzeSelectedPile !== null && !analyzeBlind) {
    const selPile = analyzeVisiblePiles.find(p => p.id === analyzeSelectedPile);
    if (selPile) {
      const pad = 10 * dpr, rowH = 22 * dpr, circR = 5 * dpr;
      const boxW = 180 * dpr;
      const boxH = pad * 2 + rowH * selPile.sourceRings.length;
      const bx = 12 * dpr, by = 12 * dpr;
      ctx.save();
      ctx.fillStyle = 'rgba(13,15,19,0.78)';
      ctx.fillRect(bx, by, boxW, boxH);
      selPile.sourceRings.forEach((src, i) => {
        const color = analyzeSourceColorMap[src.sourceId] || _SRC_COLORS[i % _SRC_COLORS.length];
        const ry = by + pad + rowH * i + rowH / 2;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(bx + pad + circR, ry, circR, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.font = `${11 * dpr}px system-ui`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const rawName = analyzeSourceNameMap[src.sourceId] || `Source ${i + 1}`;
        const name    = rawName.length > 20 ? rawName.slice(0, 18) + '…' : rawName;
        ctx.fillText(name, bx + pad + circR * 2 + 6 * dpr, ry);
      });
      ctx.restore();
    }
  }

  _updateAnalyzeLabels(k, kAgree, iouFilter, visible, filtered,
    visible > 0 ? totalFraction / visible : 0);
  // If the selected pile got filtered out, clear the sidebar
  if (analyzeSelectedPile !== null && !analyzeVisiblePiles.some(p => p.id === analyzeSelectedPile)) {
    analyzeSelectedPile = null;
    analyzeDetailK = null;
    _renderAnalyzePileDetail(null);
    _renderAnalyzeKDetail(null, 0);
  }
}

function _updateAnalyzeLabels(k, kAgree, iouFilter, visible, filtered, avgFraction) {
  document.getElementById('analyze-iou-label').textContent   = Math.round(iouFilter * 100) + '%';
  document.getElementById('analyze-agree-label').textContent = `≥ ${k} of ${analyzeData.mTotal}`;
  document.getElementById('analyze-agree-k-label').textContent =
    analyzeMode === 'relative'
      ? `≥ ${kAgree}%`
      : `≥ ${kAgree}/${analyzeData.mTotal}`;
  const total = analyzeData.piles.length;
  let stats = `${visible} shown · ${filtered} filtered · ${total} total`;
  if (visible > 0) stats += ` · avg IoU: ${Math.round(avgFraction * 100)}%`;
  document.getElementById('analyze-stats').textContent = stats;
  _updateKBreakdown();
}

/* ── Shared IoU components ────────────────────────────────────────────────── */

/**
 * Bar chart of k→fraction for a pile.
 * opts.selectedK  – which row to highlight
 * opts.onKClick   – callback(k) when a row is clicked
 */
function buildAgreementBreakdown(agreementByK, m, opts = {}) {
  const { selectedK, onKClick, barColor } = opts;
  const wrap  = document.createElement('div');
  wrap.className = 'agreement-breakdown';
  const title = document.createElement('div');
  title.className   = 'breakdown-title';
  title.textContent = `${m} annotator${m !== 1 ? 's' : ''} drew this lesion`;
  wrap.appendChild(title);
  for (let ki = 1; ki <= m; ki++) {
    const entry = agreementByK[String(ki)];
    const pct   = entry ? Math.round(entry.fraction * 100) : 0;
    const row   = document.createElement('div');
    row.className = 'breakdown-row' + (selectedK === ki ? ' breakdown-row-active' : '');
    if (onKClick) row.style.cursor = 'pointer';
    row.innerHTML  = `
      <span class="breakdown-k">≥ ${ki}</span>
      <div class="breakdown-bar-wrap"><div class="breakdown-bar" style="width:${pct}%"></div></div>
      <span class="breakdown-pct">${pct}%</span>`;
    if (barColor) row.querySelector('.breakdown-bar').style.background = barColor(ki, m);
    if (onKClick) row.addEventListener('click', () => onKClick(ki));
    wrap.appendChild(row);
  }
  return wrap;
}

function _renderAnalyzeIoUDetail(agreementByK, k) {
  const iEntry = agreementByK[String(k)];
  const uEntry = agreementByK['1'];
  if (!iEntry || !uEntry) return null;
  return buildIoUDetail(_polygonArea(iEntry.rings), _polygonArea(uEntry.rings));
}

function _renderAnalyzePileDetail(pile) {
  const el = document.getElementById('analyze-pile-detail');
  el.innerHTML = '';
  if (!pile) return;
  const kAgree = parseInt(document.getElementById('analyze-agree-k-slider').value);
  el.appendChild(buildAgreementBreakdown(pile.agreementByK, pile.m, {
    selectedK: analyzeDetailK ?? _effectiveKAgree(kAgree, pile.m),
    onKClick: ki => {
      analyzeDetailK = ki;
      _renderAnalyzePileDetail(pile);
      _renderAnalyzeKDetail(pile, ki);
    },
    barColor: (ki, mPile) => _hexToRgba(analyzeAnnotColor, Math.min(1,
      (analyzeMode === 'absolute' ? ki / analyzeData.mTotal : ki / mPile) * analyzeAnnotOpacity)),
  }));
}

function _renderAnalyzeKDetail(pile, k) {
  const el = document.getElementById('analyze-k-detail');
  el.innerHTML = '';
  if (!pile || k < 1) return;
  const detail = _renderAnalyzeIoUDetail(pile.agreementByK, k);
  if (detail) el.appendChild(detail);
}

/* ── Set picker (inside setup-card) ──────────────────────────────────────── */
function _renderAnalyzePairList() {
  const list     = document.getElementById('analyze-pair-list');
  const eligible = availablePairs.filter(p => p.kind === 'merged' || p.kind === 'reannotated');
  list.innerHTML = '';
  analyzeSelectedId = null;
  document.getElementById('analyze-go-btn').disabled = true;

  if (!eligible.length) {
    const msg = document.createElement('p');
    msg.className   = 'pair-empty';
    msg.textContent = 'No merged or reannotated sets yet. Save a comparison first.';
    list.appendChild(msg);
    return;
  }

  for (const p of eligible) {
    const nameEl = document.createElement('strong');
    nameEl.className   = 'pair-name';
    nameEl.textContent = p.display_name;

    const tagsRow = document.createElement('div');
    tagsRow.className = 'pair-tags-row';
    _makeKindTag(p).forEach(t => tagsRow.appendChild(t));

    const metaEl = document.createElement('span');
    metaEl.textContent = _countLabel(p);

    const left = document.createElement('div');
    left.className = 'pair-item-left';
    left.append(nameEl, tagsRow, metaEl);

    const div = document.createElement('div');
    div.className  = 'pair-item';
    div.dataset.id = p.id;
    div.append(left);
    div.addEventListener('click', () => {
      list.querySelectorAll('.pair-item').forEach(el => el.classList.remove('selected'));
      div.classList.add('selected');
      analyzeSelectedId = p.id;
      document.getElementById('analyze-go-btn').disabled = false;
    });
    list.appendChild(div);
  }
}

/* ── Screen transitions ───────────────────────────────────────────────────── */
function showAnalyzeSetup() {
  _hideAllSetupScreens();
  document.getElementById('analyze-setup').hidden = false;
  _renderAnalyzePairList();
}

async function enterAnalyzeViewer(setId) {
  document.getElementById('analyze-go-btn').disabled = true;
  document.getElementById('analyze-go-btn').textContent = 'Loading…';

  let data;
  try {
    const r = await fetch(`/api/analyze/${encodeURIComponent(setId)}`);
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      alert('Analyze failed: ' + (e.error ?? r.status));
      document.getElementById('analyze-go-btn').disabled  = false;
      document.getElementById('analyze-go-btn').textContent = 'Analyze →';
      return;
    }
    data = await r.json();
  } catch (err) {
    alert('Analyze failed: ' + err.message);
    document.getElementById('analyze-go-btn').disabled  = false;
    document.getElementById('analyze-go-btn').textContent = 'Analyze →';
    return;
  }

  analyzeData = data;
  document.getElementById('analyze-go-btn').textContent = 'Analyze →';

  // Build consistent source → color/name mappings for this dataset
  analyzeSourceIds = [...new Set(data.piles.flatMap(p => p.sourceRings.map(s => s.sourceId)))].sort();
  analyzeSourceColorMap = Object.fromEntries(
    analyzeSourceIds.map((sid, i) => [sid, _SRC_COLORS[i % _SRC_COLORS.length]])
  );
  analyzeSourceNameMap = Object.fromEntries(
    analyzeSourceIds.map((sid, i) => {
      const known = (typeof availablePairs !== 'undefined' ? availablePairs : []).find(p => p.id === sid);
      return [sid, known ? known.display_name : `Source ${i + 1}`];
    })
  );

  // Reset all state before any drawing
  analyzeMode         = 'absolute';   // force=true in _switchAnalyzeMode handles slider reset
  analyzeAnnotOpacity = 0.50;
  analyzeBbox         = true;
  analyzeBlind        = false;
  analyzeAnnotColor   = '#4a9eff';
  analyzeSelectedPile = null;
  analyzeDetailK      = null;
  analyzeVisiblePiles = [];

  // Reset controls
  const agreeSlider  = document.getElementById('analyze-agree-slider');
  agreeSlider.min    = '0';
  agreeSlider.max    = String(data.mTotal);
  agreeSlider.value  = '2';
  document.getElementById('analyze-iou-slider').value = '1';
  document.getElementById('analyze-bbox-btn').classList.add('active');
  document.getElementById('analyze-blind-btn').classList.remove('active');
  document.getElementById('analyze-color-pick').value = '#4a9eff';
  const opacitySlider = document.getElementById('analyze-opacity-slider');
  if (opacitySlider) opacitySlider.value = '50';
  const opacityVal = document.getElementById('analyze-opacity-val');
  if (opacityVal) opacityVal.textContent = '50%';
  document.getElementById('analyze-pile-detail').innerHTML = '';
  document.getElementById('analyze-k-detail').innerHTML   = '';
  // Set k-slider range + mode button state (force=true → defaults: abs=mTotal, rel=100%)
  _switchAnalyzeMode('absolute', data.mTotal, true);

  // Show viewer
  document.getElementById('analyze-screen').hidden = false;
  document.getElementById('setup-screen').hidden   = true;
  document.getElementById('analyze-set-name').textContent = data.displayName;

  // Load overview image and frame once loaded
  analyzeImg     = new Image();
  analyzeImg.src = `/api/image/${data.imageHash}`;
  analyzeImg.onload = () => {
    _resizeAnalyzeCanvas();
    _frameAnalyzeUnion();
    _drawAnalyzeCanvas();
  };

  // Delay resize by one frame so the browser reflows before we read clientWidth
  requestAnimationFrame(() => {
    _resizeAnalyzeCanvas();
    _frameAnalyzeUnion();
    _drawAnalyzeCanvas();
  });
}

/* ── Sidebar sync helper ──────────────────────────────────────────────────── */
function _syncAnalyzeDetail() {
  const pile   = analyzeVisiblePiles.find(p => p.id === analyzeSelectedPile) ?? null;
  const kAgree = parseInt(document.getElementById('analyze-agree-k-slider').value);
  _renderAnalyzePileDetail(pile);
  const detailK = analyzeDetailK ?? (pile ? _effectiveKAgree(kAgree, pile.m) : kAgree);
  _renderAnalyzeKDetail(pile, detailK);
}

/* ── Mode switch ──────────────────────────────────────────────────────────── */
function _switchAnalyzeMode(newMode, mTotal, force = false) {
  const modeChanged = newMode !== analyzeMode;
  if (!modeChanged && !force) return;   // clicking the already-active button → no-op
  const m = mTotal ?? (analyzeData ? analyzeData.mTotal : 3);
  const kAgreeSlider = document.getElementById('analyze-agree-k-slider');
  const prevVal = parseInt(kAgreeSlider.value) || 0;
  analyzeMode = newMode;
  if (newMode === 'absolute') {
    kAgreeSlider.min = '0';
    kAgreeSlider.max = String(m);
    kAgreeSlider.value = force ? String(m) : String(Math.round(prevVal / 100 * m));  // rel→abs, default=mTotal
  } else {
    kAgreeSlider.min = '0';
    kAgreeSlider.max = '100';
    kAgreeSlider.value = force ? '100' : String(Math.round(prevVal / m * 100));  // abs→rel, default=100%
  }
  analyzeDetailK = null;
  document.getElementById('analyze-mode-abs').classList.toggle('active', newMode === 'absolute');
  document.getElementById('analyze-mode-rel').classList.toggle('active', newMode === 'relative');
  _updateKBreakdown();
  if (analyzeData) { _drawAnalyzeCanvas(); _syncAnalyzeDetail(); }
}

/* ── Init ─────────────────────────────────────────────────────────────────── */
function initAnalyze() {
  _initAnalyzeCanvas();
  window.addEventListener('resize', () => {
    if (!document.getElementById('analyze-screen').hidden) _resizeAnalyzeCanvas();
  });

  document.getElementById('analyze-home-btn').addEventListener('click', () => {
    document.getElementById('analyze-screen').hidden = true;
    document.getElementById('setup-screen').hidden   = false;
    analyzeData = null;
    showHomeScreen();
  });
  document.getElementById('home-btn-analyze').addEventListener('click', showHomeScreen);

  document.getElementById('analyze-go-btn').addEventListener('click', () => {
    if (analyzeSelectedId) enterAnalyzeViewer(analyzeSelectedId);
  });

  document.getElementById('analyze-agree-slider').addEventListener('input', () => {
    _drawAnalyzeCanvas();
    _syncAnalyzeDetail();
  });
  document.getElementById('analyze-agree-k-slider').addEventListener('input', () => {
    analyzeDetailK = null;
    _drawAnalyzeCanvas();
    _syncAnalyzeDetail();
  });
  document.getElementById('analyze-iou-slider').addEventListener('input', _drawAnalyzeCanvas);

  // Mode toggle
  document.getElementById('analyze-mode-abs').addEventListener('click', () => _switchAnalyzeMode('absolute'));
  document.getElementById('analyze-mode-rel').addEventListener('click', () => _switchAnalyzeMode('relative'));

  // Opacity popup
  document.getElementById('analyze-opacity-btn').addEventListener('click', e => {
    const popup = document.getElementById('analyze-opacity-popup');
    popup.hidden = !popup.hidden;
    e.stopPropagation();
  });
  document.addEventListener('click', e => {
    const popup = document.getElementById('analyze-opacity-popup');
    if (!popup.hidden && !popup.contains(e.target) &&
        e.target.id !== 'analyze-opacity-btn') {
      popup.hidden = true;
    }
  });
  document.getElementById('analyze-opacity-slider').addEventListener('input', e => {
    analyzeAnnotOpacity = parseInt(e.target.value) / 100;
    document.getElementById('analyze-opacity-val').textContent = e.target.value + '%';
    _drawAnalyzeCanvas();
  });

  document.getElementById('analyze-bbox-btn').addEventListener('click', () => {
    analyzeBbox = !analyzeBbox;
    document.getElementById('analyze-bbox-btn').classList.toggle('active', analyzeBbox);
    _drawAnalyzeCanvas();
  });

  document.getElementById('analyze-blind-btn').addEventListener('click', () => {
    analyzeBlind = !analyzeBlind;
    document.getElementById('analyze-blind-btn').classList.toggle('active', analyzeBlind);
    _drawAnalyzeCanvas();
  });

  document.getElementById('analyze-color-pick').addEventListener('input', e => {
    analyzeAnnotColor = e.target.value;
    _updateKSliderFill();
    _drawAnalyzeCanvas();
  });

  // Tooltip toggles
  [
    ['analyze-agree-info-btn',   'analyze-agree-tooltip'],
    ['analyze-agree-k-info-btn', 'analyze-agree-k-tooltip'],
    ['analyze-iou-info-btn',     'analyze-iou-tooltip'],
    ['analyze-mode-info-btn',    'analyze-mode-tooltip'],
  ].forEach(([btnId, tipId]) => {
    document.getElementById(btnId).addEventListener('click', () => {
      const tip = document.getElementById(tipId);
      tip.hidden = !tip.hidden;
    });
  });

  // Mouse-wheel to step sliders
  function _sliderWheel(sliderId) {
    document.getElementById(sliderId).addEventListener('wheel', e => {
      e.preventDefault();
      const el  = document.getElementById(sliderId);
      const step = e.deltaY < 0 ? 1 : -1;
      el.value  = String(Math.max(+el.min, Math.min(+el.max, +el.value + step)));
      el.dispatchEvent(new Event('input'));
    }, { passive: false });
  }
  _sliderWheel('analyze-agree-slider');
  _sliderWheel('analyze-agree-k-slider');
  _sliderWheel('analyze-iou-slider');
  _sliderWheel('analyze-opacity-slider');


  document.getElementById('analyze-byline-change-btn').addEventListener('click', () => {
    openBylineModal(null);
  });
}
