/* ── Card list modal ─────────────────────────────────────────────────────── */
let modalContext = null;

function triedCards() {
  return session.shapePool.filter(
    i => (session.attempts[i] ?? 0) > 0 && !session.suspended.includes(i));
}

function openCardModal(indices, title, type) {
  modalContext = { type, title };
  const tc = triedCards().length;
  const sc = session.suspended.length;
  tabTriedCount.textContent = tc;
  tabSuspCount.textContent  = sc;
  tabTried.classList.toggle('active', type === 'tried');
  tabSusp.classList.toggle('active',  type === 'suspended');
  tabTried.disabled = tc === 0;
  tabSusp.disabled  = sc === 0;

  cardModalGrid.innerHTML = '';
  for (const idx of indices) {
    const shape    = shapesData.shapes[idx];
    const attempts = session.attempts[idx] ?? 0;
    const isSusp   = session.suspended.includes(idx);

    let scoreHtml = '';
    if (session.mode !== 'label') {
      const p = Math.round((session.polygonScores[idx] ?? 0) * 100);
      scoreHtml += `<div class="modal-score">Draw <strong>${p}%</strong></div>`;
    }
    if (session.mode !== 'polygon') {
      const l     = session.labelScores[idx] ?? 0;
      const lText = attempts === 0 ? '–' : l === 1 ? '✓' : '✗';
      scoreHtml += `<div class="modal-score">Label <strong>${lText}</strong></div>`;
    }

    const card = document.createElement('div');
    card.className = 'modal-card';
    card.innerHTML =
      `<img src="/api/crop/${session.pairId}/${idx}" class="modal-card-img" loading="lazy">` +
      `<div class="modal-card-body">` +
        `<div class="modal-card-label">${shape.label}</div>` +
        scoreHtml +
        `<div class="modal-card-meta">${attempts} attempt${attempts !== 1 ? 's' : ''}</div>` +
        `<div class="modal-card-actions">` +
          `<button class="modal-attempt-btn" data-idx="${idx}">Attempt →</button>` +
          `<button class="modal-susp-btn" data-idx="${idx}">${isSusp ? 'Unsuspend' : 'Suspend'}</button>` +
        `</div>` +
      `</div>`;
    cardModalGrid.appendChild(card);
  }
  cardModal.hidden = false;
}

function closeCardModal() { cardModal.hidden = true; }

function initModal() {
  document.getElementById('card-modal-close').addEventListener('click', closeCardModal);
  document.getElementById('card-modal-backdrop').addEventListener('click', closeCardModal);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeCardModal(); });

  tabTried.addEventListener('click', () => {
    const cards = triedCards();
    if (cards.length) openCardModal(cards, 'Attempted', 'tried');
  });
  tabSusp.addEventListener('click', () => {
    if (session && session.suspended.length)
      openCardModal([...session.suspended], 'Suspended', 'suspended');
  });

  statTried.addEventListener('click', () => {
    if (!session) return;
    const cards = triedCards();
    if (!cards.length) return;
    openCardModal(cards, 'Attempted', 'tried');
  });
  statSusp.addEventListener('click', () => {
    if (!session || !session.suspended.length) return;
    openCardModal([...session.suspended], 'Suspended', 'suspended');
  });
  progressFill.addEventListener('click', () => {
    if (!session) return;
    const cards = triedCards();
    if (!cards.length) return;
    openCardModal(cards, 'Attempted', 'tried');
  });
  progressSusp.addEventListener('click', () => {
    if (!session || !session.suspended.length) return;
    openCardModal([...session.suspended], 'Suspended', 'suspended');
  });

  cardModalGrid.addEventListener('click', e => {
    const attemptBtn = e.target.closest('.modal-attempt-btn');
    if (attemptBtn) {
      const fm = modalContext;
      closeCardModal();
      loadCard(parseInt(attemptBtn.dataset.idx), fm);
      return;
    }
    const suspBtn = e.target.closest('.modal-susp-btn');
    if (!suspBtn) return;
    const idx = parseInt(suspBtn.dataset.idx);
    const i   = session.suspended.indexOf(idx);
    if (i === -1) { session.suspended.push(idx);    suspBtn.textContent = 'Unsuspend'; }
    else          { session.suspended.splice(i, 1); suspBtn.textContent = 'Suspend';   }
    saveSession();
    updateHeader();
  });
}
