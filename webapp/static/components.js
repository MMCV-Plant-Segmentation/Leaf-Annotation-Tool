/* ── Shared UI components (loaded before trainer.js and analyze.js) ───────── */

function buildIoUDetail(intersectionPx, unionPx) {
  const pct  = unionPx > 0 ? Math.round(intersectionPx / unionPx * 100) : 0;
  const fmt  = n => Math.round(n).toLocaleString();
  const wrap = document.createElement('div');
  wrap.className = 'iou-detail';
  const line = html => { const d = document.createElement('div'); d.innerHTML = html; return d; };
  wrap.appendChild(line(`∩ Intersection: <strong>${fmt(intersectionPx)} px²</strong>`));
  wrap.appendChild(line(`∪ Union: <strong>${fmt(unionPx)} px²</strong>`));
  const result = document.createElement('div');
  result.className = 'iou-detail-result';
  result.innerHTML = `IoU = ${fmt(intersectionPx)} / ${fmt(unionPx)} = <strong>${pct}%</strong>`;
  wrap.appendChild(result);
  return wrap;
}
