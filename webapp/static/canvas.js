/* ── Drawing constants ───────────────────────────────────────────────────── */
const MAX_W      = 820;
const MAX_H      = 570;
const MAX_SCALE  = 4;
const SNAP_R     = 14;
const USER_COLOR = '#4a9eff';
const GT_COLOR   = '#ff8c42';
const OVERLAY_CYCLE = ['full', 'none', 'outline'];
const OVERLAY_LABEL = { full: 'outline + fill', none: 'hidden', outline: 'outline only' };

/* ── Coordinate helpers ──────────────────────────────────────────────────── */
function eventToCanvas(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * (canvas.width  / r.width),
    y: (e.clientY - r.top)  * (canvas.height / r.height),
  };
}
function canvasToOriginal(cx, cy) {
  return { x: state.crop.x + cx / state.scale, y: state.crop.y + cy / state.scale };
}
function originalToCanvas(ox, oy) {
  return { x: (ox - state.crop.x) * state.scale, y: (oy - state.crop.y) * state.scale };
}
function isNearFirst(cx, cy) {
  if (state.verts.length < 3) return false;
  const f = originalToCanvas(state.verts[0].x, state.verts[0].y);
  return Math.hypot(cx - f.x, cy - f.y) < SNAP_R;
}

/* ── Drawing primitives ──────────────────────────────────────────────────── */
function drawPoly(pts, fillColor, strokeColor, lineWidth, dash = []) {
  if (pts.length < 2) return;
  const cv = pts.map(p => originalToCanvas(p.x, p.y));
  ctx.beginPath();
  ctx.moveTo(cv[0].x, cv[0].y);
  for (let i = 1; i < cv.length; i++) ctx.lineTo(cv[i].x, cv[i].y);
  ctx.closePath();
  if (fillColor) { ctx.fillStyle = fillColor; ctx.fill(); }
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth   = lineWidth;
  ctx.setLineDash(dash);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawOpenPoly(pts, strokeColor, lineWidth) {
  if (pts.length < 2) return;
  const cv = pts.map(p => originalToCanvas(p.x, p.y));
  ctx.beginPath();
  ctx.moveTo(cv[0].x, cv[0].y);
  for (let i = 1; i < cv.length; i++) ctx.lineTo(cv[i].x, cv[i].y);
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth   = lineWidth;
  ctx.setLineDash([]);
  ctx.stroke();
}

function drawDots(pts, color, r, goldFirst = false) {
  pts.forEach((p, i) => {
    const c = originalToCanvas(p.x, p.y);
    ctx.beginPath();
    ctx.arc(c.x, c.y, (i === 0 && goldFirst) ? r + 2 : r, 0, Math.PI * 2);
    ctx.fillStyle   = (i === 0 && goldFirst) ? '#ffd700' : color;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth   = 1;
    ctx.stroke();
  });
}

/* ── Main draw ───────────────────────────────────────────────────────────── */
function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (cropImg) ctx.drawImage(cropImg, 0, 0, canvas.width, canvas.height);

  // Label-only: faint GT outline as reference during drawing
  if (state.mode === 'label' && state.gtPoints && state.phase === 'drawing') {
    drawPoly(state.gtPoints, null, 'rgba(255,255,255,0.35)', 1.5, [4, 3]);
  }

  // Reveal: GT polygon (independent gtOverlay)
  if (state.phase === 'reveal' && state.result && state.gtOverlay !== 'none') {
    const mpts   = state.result.managerPoints.map(p => ({ x: p[0], y: p[1] }));
    const gtFill = state.gtOverlay === 'full' ? 'rgba(255,140,66,0.18)' : null;
    drawPoly(mpts, gtFill, GT_COLOR, 2.5);
    drawDots(mpts, GT_COLOR, 3);
  }

  // User polygon (independent userOverlay in reveal phase)
  if (state.verts.length >= 1) {
    const showUser = state.phase !== 'reveal' || state.userOverlay !== 'none';
    if (state.closed) {
      if (showUser) {
        const userFill = (state.phase === 'drawing') ||
                         (state.phase === 'reveal' && state.userOverlay === 'full')
          ? 'rgba(74,158,255,0.18)' : null;
        drawPoly(state.verts, userFill, USER_COLOR, 2);
      }
    } else if (state.verts.length >= 2) {
      drawOpenPoly(state.verts, USER_COLOR, 2);
    }
    if (showUser) drawDots(state.verts, USER_COLOR, 4, true);
  }

  // Preview line (drawing, open polygon)
  if (state.phase === 'drawing' && !state.closed && state.mouse && state.verts.length >= 1) {
    const last = originalToCanvas(
      state.verts[state.verts.length - 1].x,
      state.verts[state.verts.length - 1].y,
    );
    ctx.beginPath();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = 'rgba(74,158,255,0.55)';
    ctx.lineWidth   = 1.5;
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(state.mouse.x, state.mouse.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Snap ring
  if (state.phase === 'drawing' && !state.closed && state.mouse && state.verts.length >= 3) {
    if (isNearFirst(state.mouse.x, state.mouse.y)) {
      const fv = originalToCanvas(state.verts[0].x, state.verts[0].y);
      ctx.beginPath();
      ctx.arc(fv.x, fv.y, SNAP_R, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,215,0,0.85)';
      ctx.lineWidth   = 2;
      ctx.setLineDash([3, 2]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}
