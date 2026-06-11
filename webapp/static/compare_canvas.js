/* ── Compare canvas ──────────────────────────────────────────────────────── */
let overviewImg    = null;
let _cCanvasInited = false;
let focusPileId    = null;
let _cCropImg        = null;
let cropBbox       = null;

const cView = { zoom: 1, viewX: 0, viewY: 0 };

function _initCompareCanvas() {
  if (_cCanvasInited) return;
  _cCanvasInited = true;
  const cv = document.getElementById('compare-canvas');
  let dragging = false, lastX = 0, lastY = 0, downX = 0, downY = 0;
  cv.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    downX = e.clientX; downY = e.clientY;
    cv.style.cursor = 'grabbing';
  });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const dpr = window.devicePixelRatio || 1;
    cView.viewX -= (e.clientX - lastX) * dpr / cView.zoom;
    cView.viewY -= (e.clientY - lastY) * dpr / cView.zoom;
    lastX = e.clientX; lastY = e.clientY;
    drawCompareCanvas();
  });
  window.addEventListener('mouseup', e => {
    if (!dragging || e.button !== 0) return;
    dragging = false;
    cv.style.cursor = 'grab';
  });
  cv.addEventListener('click', e => {
    const dx = e.clientX - downX, dy = e.clientY - downY;
    if (dx * dx + dy * dy > 25) return; // ignore drag-release
    if (!compareSession) return;
    const r = cv.getBoundingClientRect();
    const worldX = cView.viewX + (e.clientX - r.left) * (cv.width / r.width) / cView.zoom;
    const worldY = cView.viewY + (e.clientY - r.top)  * (cv.height / r.height) / cView.zoom;
    _handleCanvasClick(worldX, worldY, e.shiftKey, e.ctrlKey || e.metaKey);
  });
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    const r  = cv.getBoundingClientRect();
    const sx = (e.clientX - r.left) * (cv.width / r.width);
    const sy = (e.clientY - r.top)  * (cv.height / r.height);
    const wx = cView.viewX + sx / cView.zoom;
    const wy = cView.viewY + sy / cView.zoom;
    const f  = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    cView.zoom  *= f;
    cView.viewX  = wx - sx / cView.zoom;
    cView.viewY  = wy - sy / cView.zoom;
    drawCompareCanvas();
  }, { passive: false });
}

function _resizeCompareCanvas() {
  const cv  = document.getElementById('compare-canvas');
  const dpr = window.devicePixelRatio || 1;
  cv.width  = Math.round((cv.clientWidth  || cv.offsetWidth)  * dpr);
  cv.height = Math.round((cv.clientHeight || cv.offsetHeight) * dpr);
}

function _frameBbox(bbox) {
  const cv = document.getElementById('compare-canvas');
  if (!cv.width || !bbox.w || !bbox.h) return;
  cView.zoom  = Math.min(cv.width / bbox.w, cv.height / bbox.h);
  cView.viewX = (bbox.x + bbox.w / 2) - cv.width  / 2 / cView.zoom;
  cView.viewY = (bbox.y + bbox.h / 2) - cv.height / 2 / cView.zoom;
}

function frameCompareUnion() {
  if (!compareSession || !compareSession.annotations.length) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const a of compareSession.annotations) {
    x0 = Math.min(x0, a.bbox[0]); y0 = Math.min(y0, a.bbox[1]);
    x1 = Math.max(x1, a.bbox[2]); y1 = Math.max(y1, a.bbox[3]);
  }
  const bw = x1 - x0, bh = y1 - y0;
  _frameBbox({
    x: Math.max(0, x0 - bw * 0.1),
    y: Math.max(0, y0 - bh * 0.1),
    w: Math.min(compareSession.imageWidth,  x1 + bw * 0.1) - Math.max(0, x0 - bw * 0.1),
    h: Math.min(compareSession.imageHeight, y1 + bh * 0.1) - Math.max(0, y0 - bh * 0.1),
  });
}

function _pileColor(pile, setId) {
  const isBlind = compareSession.phase === 'final' ? !!compareSession.finalBlind : !!compareSession.blind;
  return isBlind ? (pile.colors[setId] || '#888') : (compareSession.globalColors?.[setId] || '#888');
}

function drawCompareCanvas() {
  const cv  = document.getElementById('compare-canvas');
  const ctx = cv.getContext('2d');
  if (!compareSession) return;
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = '#0d0f13';
  ctx.fillRect(0, 0, cv.width, cv.height);

  const isFinal = compareSession.phase === 'final';
  const annById = Object.fromEntries(compareSession.annotations.map(a => [a.id, a]));

  if (focusPileId) {
    ctx.imageSmoothingEnabled = false;
    if (_cCropImg && _cCropImg.complete && cropBbox) {
      ctx.drawImage(_cCropImg,
        (cropBbox.x - cView.viewX) * cView.zoom,
        (cropBbox.y - cView.viewY) * cView.zoom,
        cropBbox.w * cView.zoom,
        cropBbox.h * cView.zoom,
      );
    }
    const pile = compareSession.piles[focusPileId];
    if (pile) {
      for (const annId of pile.annotationIds) {
        const ann = annById[annId];
        if (ann.overlay === 'none') continue;
        const color = _pileColor(pile, ann.setId);
        const ov    = isFinal
          ? (compareSession.finalBlind ? 'uniform' : 'full')
          : (ann.overlay || 'outline');
        _drawComparePoly(ctx, ann.points, color, 1, ov);
      }
    }
  } else {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (overviewImg && overviewImg.complete && overviewImg.naturalWidth) {
      ctx.drawImage(overviewImg,
        -cView.viewX * cView.zoom,
        -cView.viewY * cView.zoom,
        compareSession.imageWidth  * cView.zoom,
        compareSession.imageHeight * cView.zoom,
      );
    }
    for (const layer of compareSession.layers) {
      if (!layer.visible) continue;
      for (const pileId of layer.piles) {
        const pile = compareSession.piles[pileId];
        if (!pile.visible) continue;
        if (!isFinal && _filterHideNonConflict && !pile.flagged) continue;
        if (!isFinal && _filterHideTrivial && _isTrivialConflict(pile)) continue;
        for (const annId of pile.annotationIds) {
          const ann = annById[annId];
          if (ann.overlay === 'none') continue;
          const color = _pileColor(pile, ann.setId);
          const ov    = isFinal
            ? (compareSession.finalBlind ? 'uniform' : 'full')
            : (ann.overlay || 'outline');
          _drawComparePoly(ctx, ann.points, color, 1, ov);
        }
      }
    }
    // Bounding boxes (drawn on top of annotations)
    for (const layer of compareSession.layers) {
      if (!layer.visible) continue;
      for (const pileId of layer.piles) {
        const pile = compareSession.piles[pileId];
        if (!pile.visible || !pile.showBbox) continue;
        if (!isFinal && _filterHideNonConflict && !pile.flagged) continue;
        if (!isFinal && _filterHideTrivial && _isTrivialConflict(pile)) continue;
        _drawPileBbox(ctx, pile, annById);
      }
    }
  }

  // Dashed highlight borders for all selected/highlighted annotations
  for (const annId of _selection) {
    const ann = annById[annId];
    if (ann) _drawHighlightBorder(ctx, ann.points);
  }
}

function _drawComparePoly(ctx, points, color, alpha, overlay) {
  // overlay: 'outline' | 'full' | 'uniform'
  if (points.length < 2) return;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(
    (points[0][0] - cView.viewX) * cView.zoom,
    (points[0][1] - cView.viewY) * cView.zoom,
  );
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(
      (points[i][0] - cView.viewX) * cView.zoom,
      (points[i][1] - cView.viewY) * cView.zoom,
    );
  }
  ctx.closePath();
  ctx.globalAlpha = alpha;
  if (overlay === 'uniform') {
    ctx.fillStyle = 'rgba(74,158,255,0.22)';
    ctx.fill();
  } else if (overlay === 'full') {
    ctx.fillStyle = _hexToRgba(color, 0.18);
    ctx.fill();
    ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
  } else {
    ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
  }
  ctx.restore();
}

function _hexToRgba(hex, a) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

function _drawHighlightBorder(ctx, points) {
  if (points.length < 2) return;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo((points[0][0] - cView.viewX) * cView.zoom, (points[0][1] - cView.viewY) * cView.zoom);
  for (let i = 1; i < points.length; i++)
    ctx.lineTo((points[i][0] - cView.viewX) * cView.zoom, (points[i][1] - cView.viewY) * cView.zoom);
  ctx.closePath();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth   = 2.5;
  ctx.setLineDash([5, 4]);
  ctx.globalAlpha = 0.9;
  ctx.stroke();
  ctx.restore();
}

function _drawPileBbox(ctx, pile, annById) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const annId of pile.annotationIds) {
    const ann = annById[annId];
    if (!ann) continue;
    x0 = Math.min(x0, ann.bbox[0]); y0 = Math.min(y0, ann.bbox[1]);
    x1 = Math.max(x1, ann.bbox[2]); y1 = Math.max(y1, ann.bbox[3]);
  }
  if (!isFinite(x0)) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth   = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(
    (x0 - cView.viewX) * cView.zoom,
    (y0 - cView.viewY) * cView.zoom,
    (x1 - x0) * cView.zoom,
    (y1 - y0) * cView.zoom,
  );
  ctx.restore();
}

/* ── Zoom to pile ────────────────────────────────────────────────────────── */
function zoomToPile(pileId) {
  focusPileId   = pileId;
  const pile    = compareSession.piles[pileId];
  const annById = Object.fromEntries(compareSession.annotations.map(a => [a.id, a]));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const annId of pile.annotationIds) {
    const ann = annById[annId];
    x0 = Math.min(x0, ann.bbox[0]); y0 = Math.min(y0, ann.bbox[1]);
    x1 = Math.max(x1, ann.bbox[2]); y1 = Math.max(y1, ann.bbox[3]);
  }
  _loadCropFor(x0, y0, x1, y1, () => {
    _frameBbox(cropBbox); drawCompareCanvas(); renderCompareTree();
  });
}

function zoomOutFromPile() {
  focusPileId = null; _cCropImg = null; cropBbox = null;
  _selection.clear(); _lastClickedAnnId = null;
  frameCompareUnion(); drawCompareCanvas(); renderCompareTree();
}

function _reframeFocusedPile() {
  const pile    = compareSession.piles[focusPileId];
  if (!pile || !pile.annotationIds.length) return;
  const annById = Object.fromEntries(compareSession.annotations.map(a => [a.id, a]));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const annId of pile.annotationIds) {
    const ann = annById[annId];
    x0 = Math.min(x0, ann.bbox[0]); y0 = Math.min(y0, ann.bbox[1]);
    x1 = Math.max(x1, ann.bbox[2]); y1 = Math.max(y1, ann.bbox[3]);
  }
  _loadCropFor(x0, y0, x1, y1, () => { _frameBbox(cropBbox); drawCompareCanvas(); });
}

function _loadCropFor(x0, y0, x1, y1, onload) {
  const bw = x1 - x0, bh = y1 - y0;
  x0 = Math.max(0, x0 - bw * 0.1); y0 = Math.max(0, y0 - bh * 0.1);
  x1 = Math.min(compareSession.imageWidth,  x1 + bw * 0.1);
  y1 = Math.min(compareSession.imageHeight, y1 + bh * 0.1);
  cropBbox = { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) };
  _cCropImg = new Image();
  _cCropImg.onload = onload;
  _cCropImg.src =
    `/api/image/${compareSession.imageHash}/crop?x=${cropBbox.x}&y=${cropBbox.y}&w=${cropBbox.w}&h=${cropBbox.h}`;
}
