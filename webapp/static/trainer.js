/* ── Trainer state ───────────────────────────────────────────────────────── */
let cropImg = null;

/* ── UI helpers ──────────────────────────────────────────────────────────── */
function scoreClass(pct) {
  return pct >= 70 ? 'score-great' : pct >= 40 ? 'score-ok' : 'score-bad';
}

function updateSubmitBtn() {
  const polyOk  = state.closed;
  const labelOk = labelSelect.value !== '';
  submitBtn.disabled = !(
    state.mode === 'polygon' ? polyOk  :
    state.mode === 'label'   ? labelOk :
    polyOk && labelOk
  );
}

function updateVertCount() {
  const n = state.verts.length;
  vertCount.textContent = `${n} vert${n !== 1 ? 's' : ''}`;
  snapHint.hidden = !(n >= 3 && !state.closed);
}

function updateHeader() {
  const avg    = avgScores();
  const total  = session.shapePool.length;
  const susp   = session.suspended.length;
  const active = session.shapePool.filter(
    i => (session.attempts[i] ?? 0) > 0 && !session.suspended.includes(i)).length;

  statTried.textContent = active;
  statSusp.textContent  = susp;
  statTotal.textContent = total;
  progressFill.style.width = `${(active / total) * 100}%`;
  progressSusp.style.width = `${(susp   / total) * 100}%`;

  if (!avg.n) {
    avgText.textContent = '–';
  } else {
    const pPct = Math.round(avg.polygon * 100);
    const lPct = Math.round(avg.label   * 100);
    avgText.textContent =
      state.mode === 'polygon' ? `draw ${pPct}%` :
      state.mode === 'label'   ? `label ${lPct}%` :
                                 `draw ${pPct}% · label ${lPct}%`;
  }
}

function clearReveal() {
  rDraw.hidden           = true;
  rLabel.hidden          = true;
  rDrawBest.hidden       = true;
  rLabelBest.hidden      = true;
  rLabelResult.innerHTML = '';
  rLabelResult.className = 'r-score-row';
  rDrawVal.textContent   = '–';
  rDrawVal.className     = '';
  iouTooltip.hidden      = true;
}

function updateSuspendBtnText(idx) {
  const isSusp = session.suspended.includes(idx);
  const text = (state.fromModal && isSusp) ? 'Unsuspend this card' : 'Suspend this card';
  document.getElementById('suspend-draw-btn').textContent   = text;
  document.getElementById('suspend-reveal-btn').textContent = text;
}

/* ── Export ──────────────────────────────────────────────────────────────── */
function exportAnnotations() {
  const shapes = [];
  for (const [idx, ann] of Object.entries(session.bestAnnotations)) {
    if (ann.points?.length) {
      shapes.push({
        label:       (ann.label && ann.label !== 'idk') ? ann.label : 'unknown',
        points:      ann.points,
        group_id:    null,
        description: `poly=${(ann.polyScore ?? 0).toFixed(3)} label=${(ann.labelScore ?? 0).toFixed(3)} attempts=${session.attempts[idx] ?? 0}`,
        shape_type:  'polygon',
        flags:       {},
        mask:        null,
      });
    }
  }
  const doc = {
    version: '6.3.1', flags: {}, shapes,
    imagePath:   shapesData.imageName,
    imageData:   null,
    imageHeight: shapesData.imageHeight,
    imageWidth:  shapesData.imageWidth,
  };
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'),
                             { href: url, download: 'my_annotations.json' });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ── Load card ───────────────────────────────────────────────────────────── */
function loadCard(forceIdx = null, fromModal = null) {
  state.phase       = 'loading';
  state.verts       = [];
  state.closed      = false;
  state.mouse       = null;
  state.result      = null;
  state.gtPoints    = null;
  state.gtOverlay   = 'full';
  state.userOverlay = 'full';
  state.fromModal   = fromModal;
  clearReveal();
  drawingPanel.hidden = false;
  revealPanel.hidden  = true;
  submitBtn.disabled  = true;
  canvas.className    = '';

  const idx = forceIdx !== null ? forceIdx : nextIdx();
  if (idx === null) {
    doneScreen.hidden = false;
    state.phase = 'done';
    return;
  }

  state.shapeIdx = idx;
  const shape    = shapesData.shapes[idx];
  state.crop     = shape.crop;
  state.gtPoints = shape.points.map(p => ({ x: p[0], y: p[1] }));
  updateSuspendBtnText(idx);

  // Retry/best-score badges
  const attempts = session.attempts[idx] ?? 0;
  retryBadge.hidden      = attempts === 0;
  retryBadge.textContent = `Retry #${attempts + 1}`;

  const pBest = Math.round((session.polygonScores[idx] ?? 0) * 100);
  const lBest = Math.round((session.labelScores[idx]  ?? 0) * 100);
  prevScoreBadge.hidden = attempts === 0;
  if (attempts > 0) {
    prevScoreBadge.textContent =
      state.mode === 'polygon' ? `Best draw: ${pBest}%` :
      state.mode === 'label'   ? `Best label: ${lBest}%` :
                                 `Draw ${pBest}% · Label ${lBest}%`;
  }

  // Mode-dependent UI
  polygonSection.hidden = state.mode === 'label';
  labelSection.hidden   = state.mode === 'polygon';
  legendDraw.hidden     = state.mode === 'label';
  if (state.mode === 'label') canvas.classList.add('no-draw');

  canvasHint.textContent =
    state.mode === 'polygon' ? 'Click to add vertices · Click the first vertex (●) to close' :
    state.mode === 'label'   ? 'Identify the lesion shown · Outline is shown for reference' :
                               'Trace the polygon (click ● to close), then select a label';

  // "I don't know" option — add once per session
  if (state.mode !== 'polygon' && !labelSelect.querySelector('option[value="idk"]')) {
    const opt = document.createElement('option');
    opt.value = 'idk'; opt.textContent = "I don't know";
    labelSelect.appendChild(opt);
  }
  labelSelect.value = '';
  updateSubmitBtn();
  updateVertCount();

  cropImg = new Image();
  cropImg.onload = () => {
    const sw = MAX_W / cropImg.naturalWidth;
    const sh = MAX_H / cropImg.naturalHeight;
    state.scale   = Math.min(sw, sh, MAX_SCALE);
    canvas.width  = Math.round(cropImg.naturalWidth  * state.scale);
    canvas.height = Math.round(cropImg.naturalHeight * state.scale);
    state.phase   = 'drawing';
    draw();
  };
  cropImg.src = `/api/crop/${session.pairId}/${idx}`;
}

/* ── Submit ──────────────────────────────────────────────────────────────── */
async function submitAnnotation() {
  if (submitBtn.disabled) return;
  submitBtn.disabled = true;

  const idx         = state.shapeIdx;
  const shape       = shapesData.shapes[idx];
  const userPts     = state.verts.map(v => [v.x, v.y]);
  const chosenLabel = labelSelect.value;

  let iou = null, iouIntersection = null, iouUnion = null;
  if (state.mode !== 'label' && userPts.length >= 3) {
    const r = await fetch('/api/iou', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ a: userPts, b: shape.points }),
    });
    const d = await r.json();
    iou = d.iou; iouIntersection = d.intersection; iouUnion = d.union;
  }

  const labelMatch =
    state.mode !== 'polygon' && chosenLabel
      ? chosenLabel === shape.label
      : null;

  const polyScore  = iou ?? 0;
  const labelScore = labelMatch === true ? 1.0 : 0.0;

  const prevP = session.polygonScores[idx] ?? 0;
  const prevL = session.labelScores[idx]   ?? 0;
  if (state.mode !== 'label')   session.polygonScores[idx] = Math.max(prevP, polyScore);
  if (state.mode !== 'polygon') session.labelScores[idx]   = Math.max(prevL, labelScore);
  session.attempts[idx] = (session.attempts[idx] ?? 0) + 1;

  const combined     = (polyScore  + labelScore)  / 2;
  const prevCombined = (prevP + prevL) / 2;
  if (combined >= prevCombined) {
    session.bestAnnotations[idx] = { points: userPts, label: chosenLabel, polyScore, labelScore };
  }
  saveSession();

  state.result = {
    iou, iouIntersection, iouUnion, labelMatch,
    managerLabel:  shape.label,
    managerPoints: shape.points,
    polyScore,  labelScore,
    prevPolygon: prevP,  prevLabel: prevL,
    bestPolygon: session.polygonScores[idx] ?? 0,
    bestLabel:   session.labelScores[idx]   ?? 0,
    attempts:    session.attempts[idx],
  };
  state.phase = 'reveal';

  // Drawing score
  rDraw.hidden = state.mode === 'label';
  if (state.mode !== 'label') {
    const pPct = Math.round(polyScore * 100);
    rDrawVal.textContent = `${pPct}%`;
    rDrawVal.className   = scoreClass(pPct);
    const bestP    = Math.round(state.result.bestPolygon * 100);
    const prevPPct = Math.round(prevP * 100);
    if (session.attempts[idx] > 1 || prevP > 0) {
      rDrawBest.hidden = false;
      rDrawBestVal.textContent = prevP !== state.result.bestPolygon
        ? `${bestP}% (was ${prevPPct}%)` : `${bestP}%`;
    }
  }

  // Label result
  rLabel.hidden = state.mode === 'polygon';
  if (state.mode !== 'polygon') {
    const lm     = labelMatch;
    const chosen = chosenLabel === 'idk' ? "I don't know" : chosenLabel;
    if (lm === true) {
      rLabelResult.className = 'r-score-row';
      rLabelResult.innerHTML = `<span class="r-dim">Label</span><span class="pass">✓&nbsp;${chosen}</span>`;
    } else if (lm === false) {
      rLabelResult.className = '';
      rLabelResult.innerHTML =
        `<div class="r-score-row"><span class="r-dim">Label</span><span class="fail">✗&nbsp;${chosen}</span></div>` +
        `<div class="r-correct">→&nbsp;<em>${shape.label}</em></div>`;
    } else {
      rLabelResult.className = 'r-score-row';
      rLabelResult.innerHTML = `<span class="r-dim">Label</span><span class="muted">–</span>`;
    }
    const bestL    = Math.round(state.result.bestLabel * 100);
    const prevLPct = Math.round(prevL * 100);
    if (session.attempts[idx] > 1 || prevL > 0) {
      rLabelBest.hidden = false;
      rLabelBestVal.textContent = prevL !== state.result.bestLabel
        ? `${bestL}% (was ${prevLPct}%)` : `${bestL}%`;
    }
  }

  legendUserRow.hidden = state.mode === 'label' || state.verts.length === 0;
  redoBtn.hidden       = state.mode === 'label'; // immediate retry on multiple-choice is pointless
  nextBtn.textContent  = state.fromModal ? '← Back to list' : 'Next Card →';
  drawingPanel.hidden  = true;
  revealPanel.hidden   = false;
  canvasHint.textContent = 'Click legend entries to toggle overlays independently';
  updateHeader();
  draw();
}

/* ── Suspend ─────────────────────────────────────────────────────────────── */
function suspendCard() {
  const idx = state.shapeIdx;
  if (state.fromModal) {
    // Toggle mode — don't navigate away
    if (idx !== null) {
      const i = session.suspended.indexOf(idx);
      if (i === -1) session.suspended.push(idx);
      else          session.suspended.splice(i, 1);
      saveSession();
      updateHeader();
      updateSuspendBtnText(idx);
    }
    return;
  }
  // Normal mode — suspend and advance
  if (idx !== null && !session.suspended.includes(idx)) {
    session.suspended.push(idx);
    saveSession();
    updateHeader();
  }
  loadCard();
}

/* ── Trainer init ────────────────────────────────────────────────────────── */
function initTrainer() {
  // Canvas events
  canvas.addEventListener('click', e => {
    if (state.phase !== 'drawing') return;
    if (state.mode  === 'label')   return;
    if (state.closed)              return;
    const c = eventToCanvas(e);
    if (isNearFirst(c.x, c.y)) {
      state.closed = true;
      updateSubmitBtn();
      draw();
      return;
    }
    state.verts.push(canvasToOriginal(c.x, c.y));
    updateSubmitBtn();
    updateVertCount();
    draw();
  });

  canvas.addEventListener('mousemove', e => {
    if (state.phase !== 'drawing') return;
    state.mouse = eventToCanvas(e);
    updateVertCount();
    draw();
  });

  canvas.addEventListener('mouseleave', () => { state.mouse = null; draw(); });

  // Overlay legend toggles
  legendGtRow.addEventListener('click', () => {
    if (state.phase !== 'reveal') return;
    const i = OVERLAY_CYCLE.indexOf(state.gtOverlay);
    state.gtOverlay = OVERLAY_CYCLE[(i + 1) % OVERLAY_CYCLE.length];
    canvasHint.textContent = `GT: ${OVERLAY_LABEL[state.gtOverlay]} · Yours: ${OVERLAY_LABEL[state.userOverlay]}`;
    draw();
  });

  legendUserRow.addEventListener('click', () => {
    if (state.phase !== 'reveal') return;
    const i = OVERLAY_CYCLE.indexOf(state.userOverlay);
    state.userOverlay = OVERLAY_CYCLE[(i + 1) % OVERLAY_CYCLE.length];
    canvasHint.textContent = `GT: ${OVERLAY_LABEL[state.gtOverlay]} · Yours: ${OVERLAY_LABEL[state.userOverlay]}`;
    draw();
  });

  // IoU tooltip
  iouInfoBtn.addEventListener('click', () => {
    iouTooltip.hidden = !iouTooltip.hidden;
    if (!iouTooltip.hidden && state.result) {
      const inter = Math.round(state.result.iouIntersection ?? 0);
      const union  = Math.round(state.result.iouUnion ?? 0);
      const pct   = Math.round((state.result.iou ?? 0) * 100);
      iouCalcLines.innerHTML =
        `<div>∩ Intersection: <strong>${inter.toLocaleString()} px²</strong></div>` +
        `<div>∪ Union: <strong>${union.toLocaleString()} px²</strong></div>` +
        `<div>IoU = ${inter.toLocaleString()} / ${union.toLocaleString()} = <strong>${pct}%</strong></div>`;
    }
  });

  // Drawing panel
  undoBtn.addEventListener('click', () => {
    if (state.closed) state.closed = false; else state.verts.pop();
    updateSubmitBtn(); updateVertCount(); draw();
  });
  clearBtn.addEventListener('click', () => {
    state.verts = []; state.closed = false;
    updateSubmitBtn(); updateVertCount(); draw();
  });
  labelSelect.addEventListener('change', updateSubmitBtn);
  submitBtn.addEventListener('click', submitAnnotation);

  // Reveal panel
  nextBtn.addEventListener('click', () => {
    if (state.fromModal) {
      const fm = state.fromModal;
      state.fromModal = null;
      const indices = fm.type === 'tried' ? triedCards() : [...session.suspended];
      loadCard();
      openCardModal(indices, fm.title, fm.type);
    } else {
      loadCard();
    }
  });
  redoBtn.addEventListener('click', () => loadCard(state.shapeIdx, state.fromModal));

  document.getElementById('suspend-draw-btn').addEventListener('click',   () => suspendCard());
  document.getElementById('suspend-reveal-btn').addEventListener('click', () => suspendCard());

  // Export
  document.getElementById('export-btn').addEventListener('click',      exportAnnotations);
  document.getElementById('export-done-btn').addEventListener('click', exportAnnotations);

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (state.phase === 'setup')       return;
    if (e.target.tagName === 'SELECT') return;
    if (e.key === 'z' && (e.ctrlKey || e.metaKey)) { undoBtn.click(); e.preventDefault(); }
    if (e.key === 'Escape')  clearBtn.click();
    if (e.key === 'Enter' && state.phase === 'drawing') submitBtn.click();
    if (e.key === 'Enter' && state.phase === 'reveal')  nextBtn.click();
  });
}
