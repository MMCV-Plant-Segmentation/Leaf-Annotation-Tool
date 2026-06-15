/* ── Pair state ──────────────────────────────────────────────────────────── */
let selectedPairId = null;
let availablePairs = [];

/* ── Kind tag helper ─────────────────────────────────────────────────────── */
function _makeKindTag(p) {
  const tag = document.createElement('span');
  tag.className = 'set-kind-tag set-kind-' + p.kind;
  tag.textContent = p.kind;
  if (p.terminal) {
    const lock = document.createElement('span');
    lock.className = 'set-kind-tag set-kind-terminal';
    lock.textContent = 'locked';
    return [tag, lock];
  }
  return [tag];
}

/* ── Pair selection (training config) ───────────────────────────────────── */
async function selectPair(pairId) {
  selectedPairId = pairId;
  document.querySelectorAll('#pair-list .pair-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.id === pairId);
  });
  shapesData = await fetch(`/api/shapes?pair=${encodeURIComponent(pairId)}`).then(r => r.json());
  const total = shapesData.shapes.length;
  nSlider.max = total; nSlider.value = total;
  nDisplay.textContent = `All (${total})`;
  startBtn.disabled = false;
}

/* ── Training config: read-only pair picker ──────────────────────────────── */
function renderPairList(pairs) {
  availablePairs = pairs;
  const list = document.getElementById('pair-list');
  list.innerHTML = '';
  if (!pairs.length) {
    const msg = document.createElement('p');
    msg.className = 'pair-empty';
    msg.textContent = 'No annotation sets yet. ';
    const manageBtn = document.createElement('button');
    manageBtn.className   = 'btn-text';
    manageBtn.textContent = 'Manage Sets →';
    manageBtn.addEventListener('click', showManageScreen);
    msg.appendChild(manageBtn);
    list.appendChild(msg);
    return;
  }
  for (const p of pairs) {
    const nameEl = document.createElement('strong');
    nameEl.className   = 'pair-name';
    nameEl.textContent = p.display_name;

    const tagsRow = document.createElement('div');
    tagsRow.className = 'pair-tags-row';
    _makeKindTag(p).forEach(t => tagsRow.appendChild(t));

    const metaEl = document.createElement('span');
    metaEl.textContent = p.shape_count + ' shapes';

    const left = document.createElement('div');
    left.className = 'pair-item-left';
    left.append(nameEl, tagsRow, metaEl);

    const div = document.createElement('div');
    div.className  = 'pair-item';
    div.dataset.id = p.id;
    div.append(left);
    div.addEventListener('click', () => selectPair(p.id));

    const entry = document.createElement('div');
    entry.className = 'pair-entry';
    entry.append(div);
    list.appendChild(entry);
  }
}

/* ── Manage Sets: full CRUD pair list ────────────────────────────────────── */
function renderManagePairList(pairs) {
  const list = document.getElementById('manage-pair-list');
  list.innerHTML = '';
  if (!pairs.length) {
    const msg = document.createElement('p');
    msg.className   = 'pair-empty';
    msg.textContent = 'No annotation sets yet. Click "Add new annotation set" below.';
    list.appendChild(msg);
    return;
  }
  for (const p of pairs) {
    const nameEl = document.createElement('strong');
    nameEl.className   = 'pair-name';
    nameEl.textContent = p.display_name;

    const tagsRow = document.createElement('div');
    tagsRow.className = 'pair-tags-row';
    _makeKindTag(p).forEach(t => tagsRow.appendChild(t));

    const metaEl = document.createElement('span');
    metaEl.textContent = p.shape_count + ' shapes';

    const left = document.createElement('div');
    left.className = 'pair-item-left';
    left.append(nameEl, tagsRow, metaEl);

    const editBtn = document.createElement('button');
    editBtn.className = 'pair-edit-btn'; editBtn.title = 'Rename'; editBtn.textContent = '✎';

    const replaceBtn = document.createElement('button');
    replaceBtn.className = 'pair-replace-btn'; replaceBtn.title = 'Replace files'; replaceBtn.textContent = '↻';

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'pair-delete-btn'; deleteBtn.title = 'Delete'; deleteBtn.textContent = '✕';

    const actionBtns = document.createElement('div');
    actionBtns.className = 'pair-action-btns';
    actionBtns.append(editBtn, replaceBtn, deleteBtn);

    const confirmLabel = document.createElement('span');
    confirmLabel.textContent = 'Delete?';
    const confirmYes = document.createElement('button');
    confirmYes.className = 'btn-secondary'; confirmYes.textContent = 'Yes';
    confirmYes.style.cssText = 'flex:none;padding:2px 8px';
    const confirmNo = document.createElement('button');
    confirmNo.className = 'btn-text'; confirmNo.textContent = 'No';

    const deleteConfirm = document.createElement('div');
    deleteConfirm.className = 'pair-delete-confirm';
    deleteConfirm.hidden = true;
    deleteConfirm.append(confirmLabel, confirmYes, confirmNo);

    const div = document.createElement('div');
    div.className  = 'pair-item';
    div.dataset.id = p.id;
    div.append(left, actionBtns, deleteConfirm);

    const entry = document.createElement('div');
    entry.className = 'pair-entry';
    entry.append(div, buildReplaceForm(entry, p));
    list.appendChild(entry);

    editBtn.addEventListener('click', e => { e.stopPropagation(); startRenaming(div, p); });
    replaceBtn.addEventListener('click', e => {
      e.stopPropagation();
      const form = entry.querySelector('.pair-replace-form');
      const open = form.hidden;
      form.hidden = !open;
      entry.classList.toggle('replacing', open);
    });
    deleteBtn.addEventListener('click', e => {
      e.stopPropagation();
      actionBtns.hidden = true;
      deleteConfirm.hidden = false;
    });
    confirmYes.addEventListener('click', async e => { e.stopPropagation(); await deletePair(p.id); });
    confirmNo.addEventListener('click', e => {
      e.stopPropagation();
      deleteConfirm.hidden = true;
      actionBtns.hidden = false;
    });
  }
}

function buildReplaceForm(entryEl, pair) {
  const form = document.createElement('div');
  form.className = 'pair-replace-form';
  form.hidden = true;
  const IMG_DFLT  = `current (.${pair.image_ext})`;
  const JSON_DFLT = 'current (.json)';

  form.innerHTML = `
    <div class="upload-file-row">
      <label class="upload-file-btn"><span class="replace-file-hint">${IMG_DFLT}</span><input type="file" accept=".tif,.tiff,.png,.jpg,.jpeg"></label>
      <label class="upload-file-btn"><span class="replace-file-hint">${JSON_DFLT}</span><input type="file" accept=".json"></label>
    </div>
    <div class="pair-replace-footer">
      <button class="btn-secondary" style="flex:none;padding:5px 14px">Save</button>
      <button class="btn-text">Cancel</button>
      <p class="upload-status" hidden style="margin-left:4px"></p>
    </div>`;

  const [imgLabel, jsonLabel] = form.querySelectorAll('.upload-file-btn');
  const imgInput  = imgLabel.querySelector('input');
  const jsonInput = jsonLabel.querySelector('input');
  const imgSpan   = imgLabel.querySelector('span');
  const jsonSpan  = jsonLabel.querySelector('span');
  const saveBtn   = form.querySelector('.btn-secondary');
  const cancelBtn = form.querySelector('.btn-text');
  const statusEl  = form.querySelector('.upload-status');

  imgInput.addEventListener('change', e => {
    const f = e.target.files[0];
    imgSpan.textContent = f ? f.name : IMG_DFLT;
    imgSpan.classList.toggle('replace-file-hint', !f);
  });
  jsonInput.addEventListener('change', e => {
    const f = e.target.files[0];
    jsonSpan.textContent = f ? f.name : JSON_DFLT;
    jsonSpan.classList.toggle('replace-file-hint', !f);
  });

  const close = () => {
    form.hidden = true;
    entryEl.classList.remove('replacing');
    imgInput.value = ''; jsonInput.value = '';
    imgSpan.textContent = IMG_DFLT; imgSpan.classList.add('replace-file-hint');
    jsonSpan.textContent = JSON_DFLT; jsonSpan.classList.add('replace-file-hint');
    statusEl.hidden = true;
  };

  cancelBtn.addEventListener('click', close);
  saveBtn.addEventListener('click', async () => {
    const imgFile  = imgInput.files[0];
    const jsonFile = jsonInput.files[0];
    if (!imgFile && !jsonFile) {
      statusEl.textContent = 'Select at least one file to replace.';
      statusEl.style.color = 'var(--fail)';
      statusEl.hidden = false;
      return;
    }
    saveBtn.disabled = true;
    statusEl.textContent = 'Saving…'; statusEl.style.color = ''; statusEl.hidden = false;
    try {
      const fd = new FormData();
      if (imgFile)  fd.append('image', imgFile);
      if (jsonFile) fd.append('json',  jsonFile);
      const r = await fetch(`/api/images/${encodeURIComponent(pair.id)}`, { method: 'PUT', body: fd });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error ?? 'Replace failed'); }
      const updated = await r.json();
      const i = availablePairs.findIndex(q => q.id === pair.id);
      if (i !== -1) availablePairs[i] = updated;
      pair.shape_count = updated.shape_count;
      renderManagePairList(availablePairs);
      renderPairList(availablePairs);
    } catch (e) {
      statusEl.textContent = e.message;
      statusEl.style.color = 'var(--fail)';
    } finally {
      saveBtn.disabled = false;
    }
  });

  return form;
}

async function deletePair(pairId) {
  try {
    const r = await fetch(`/api/images/${encodeURIComponent(pairId)}`, { method: 'DELETE' });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error ?? 'Delete failed'); }
    if (session && session.pairId === pairId) { localStorage.removeItem(SESSION_KEY); session = null; }
    availablePairs = availablePairs.filter(p => p.id !== pairId);
    if (selectedPairId === pairId) {
      selectedPairId = null;
      startBtn.disabled = true;
    }
    renderManagePairList(availablePairs);
    renderPairList(availablePairs);
  } catch (e) {
    console.error('Delete failed:', e);
    renderManagePairList(availablePairs);
  }
}

function startRenaming(itemEl, pair) {
  const nameEl     = itemEl.querySelector('.pair-name');
  const actionBtns = itemEl.querySelector('.pair-action-btns');

  const input = document.createElement('input');
  input.type      = 'text';
  input.value     = pair.display_name;
  input.className = 'pair-rename-input';
  nameEl.replaceWith(input);
  actionBtns.hidden = true;
  input.focus();
  input.select();

  const save = async () => {
    const newName = input.value.trim();
    if (newName && newName !== pair.display_name) {
      await fetch(`/api/images/${encodeURIComponent(pair.id)}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ display_name: newName }),
      });
      pair.display_name = newName;
      const i = availablePairs.findIndex(q => q.id === pair.id);
      if (i !== -1) availablePairs[i].display_name = newName;
      renderPairList(availablePairs);
    }
    renderManagePairList(availablePairs);
  };

  input.addEventListener('blur',    save);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = pair.display_name; input.blur(); }
  });
}

/* ── Manage Sets screen ──────────────────────────────────────────────────── */
function showManageScreen() {
  _hideAllSetupScreens();
  document.getElementById('manage-screen').hidden = false;
  renderManagePairList(availablePairs);
}

/* ── Fork / config screens (training flow) ───────────────────────────────── */
function showFork(saved) {
  const pair = availablePairs.find(p => p.id === saved.pairId);
  if (!pair) { showConfig(false); return; }

  const tried = saved.shapePool.filter(i => (saved.attempts[i] ?? 0) > 0);
  const n     = tried.length;
  const avg   = {
    polygon: n ? tried.reduce((a, i) => a + (saved.polygonScores[i] ?? 0), 0) / n : 0,
    label:   n ? tried.reduce((a, i) => a + (saved.labelScores[i]   ?? 0), 0) / n : 0,
  };
  const modeLabel = { both: 'polygon + label', polygon: 'polygon only', label: 'label only' }[saved.mode] ?? saved.mode;
  let info = `<strong>${pair.display_name}</strong><br>${modeLabel} · ${saved.shapePool.length} cards · ${n} attempted`;
  if (n > 0) {
    if (saved.mode !== 'label')   info += `<br>Draw avg: ${Math.round(avg.polygon * 100)}%`;
    if (saved.mode !== 'polygon') info += `<br>Label avg: ${Math.round(avg.label * 100)}%`;
  }
  if (saved.suspended.length > 0) info += `<br>${saved.suspended.length} suspended`;
  document.getElementById('fork-session-info').innerHTML = info;

  document.getElementById('fork-screen').hidden     = false;
  document.getElementById('config-screen').hidden   = true;
  document.getElementById('add-pair-screen').hidden = true;
}

function showConfig(showBack) {
  document.getElementById('fork-screen').hidden     = true;
  document.getElementById('config-screen').hidden   = false;
  document.getElementById('add-pair-screen').hidden = true;
  document.getElementById('back-fork-btn').hidden   = !showBack;
}

function showAddPair() {
  document.getElementById('fork-screen').hidden     = true;
  document.getElementById('config-screen').hidden   = true;
  document.getElementById('add-pair-screen').hidden = false;
  document.getElementById('manage-screen').hidden   = true;
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

/* ── Setup init ──────────────────────────────────────────────────────────── */
function initSetup() {
  document.getElementById('dismiss-deleted-notice').addEventListener('click', () => {
    document.getElementById('session-deleted-notice').hidden = true;
  });

  // Mode checkbox highlight
  const syncCheckStyles = () => {
    cbPolygon.closest('.mode-check').classList.toggle('selected', cbPolygon.checked);
    cbLabel.closest('.mode-check').classList.toggle('selected',   cbLabel.checked);
  };
  cbPolygon.addEventListener('change', syncCheckStyles);
  cbLabel.addEventListener('change',   syncCheckStyles);
  syncCheckStyles();

  // Card count slider display
  nSlider.addEventListener('input', () => {
    const n = parseInt(nSlider.value), max = parseInt(nSlider.max);
    nDisplay.textContent = n === max ? `All (${n})` : String(n);
  });

  // Fork: continue
  document.getElementById('resume-btn').addEventListener('click', async () => {
    const saved = readSession();
    if (!saved) return;
    if (selectedPairId !== saved.pairId) await selectPair(saved.pairId);
    resumeSession(saved);
    enterApp();
  });

  // Fork: new session
  document.getElementById('new-session-btn').addEventListener('click', () => {
    showConfig(true);
  });

  // Config: back to fork
  document.getElementById('back-fork-btn').addEventListener('click', () => {
    const saved = readSession();
    if (saved) showFork(saved); else showConfig(false);
  });

  // Config: start
  startBtn.addEventListener('click', () => {
    if (!cbPolygon.checked && !cbLabel.checked) { modeError.hidden = false; return; }
    modeError.hidden = true;
    const mode = cbPolygon.checked && cbLabel.checked ? 'both'
               : cbPolygon.checked ? 'polygon' : 'label';
    newSession(mode, parseInt(nSlider.value), selectedPairId);
    enterApp();
  });

  // Home buttons in training flow
  document.getElementById('home-btn-fork').addEventListener('click', showHomeScreen);
  document.getElementById('home-btn-config').addEventListener('click', showHomeScreen);

  // Manage Sets screen
  document.getElementById('manage-add-btn').addEventListener('click', showAddPair);
  document.getElementById('manage-home-btn').addEventListener('click', showHomeScreen);

  // Trainer: home button → back to home screen
  document.getElementById('home-btn').addEventListener('click', () => {
    appDiv.hidden      = true;
    setupScreen.hidden = false;
    showHomeScreen();
  });

  // Done screen: reset → home screen
  document.getElementById('play-again-btn').addEventListener('click', () => {
    localStorage.removeItem(SESSION_KEY);
    session = null;
    doneScreen.hidden  = true;
    appDiv.hidden      = true;
    setupScreen.hidden = false;
    showHomeScreen();
  });

  // Add pair screen: back → manage screen
  document.getElementById('back-add-btn').addEventListener('click', showManageScreen);

  // Add pair screen: file input label feedback
  document.getElementById('add-image').addEventListener('change', e => {
    document.getElementById('add-img-label').textContent = e.target.files[0]?.name ?? 'Image…';
  });
  document.getElementById('add-json').addEventListener('change', e => {
    document.getElementById('add-json-label').textContent = e.target.files[0]?.name ?? 'JSON…';
  });

  // Add pair screen: upload submit
  document.getElementById('add-upload-btn').addEventListener('click', async () => {
    const name      = document.getElementById('add-name').value.trim();
    const imgFile   = document.getElementById('add-image').files[0];
    const jsonFile  = document.getElementById('add-json').files[0];
    const statusEl  = document.getElementById('add-status');
    const uploadBtn = document.getElementById('add-upload-btn');

    if (!name || !imgFile || !jsonFile) {
      statusEl.textContent = 'Display name, image, and JSON are all required.';
      statusEl.style.color = 'var(--fail)';
      statusEl.hidden = false;
      return;
    }
    uploadBtn.disabled   = true;
    statusEl.textContent = 'Uploading…';
    statusEl.style.color = '';
    statusEl.hidden      = false;

    try {
      const fd = new FormData();
      fd.append('image', imgFile);
      fd.append('json',  jsonFile);
      fd.append('display_name', name);
      const r = await fetch('/api/upload', { method: 'POST', body: fd });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error ?? 'Upload failed'); }
      const newPair = await r.json();
      availablePairs.push(newPair);
      renderManagePairList(availablePairs);
      renderPairList(availablePairs);
      document.getElementById('add-name').value             = '';
      document.getElementById('add-image').value            = '';
      document.getElementById('add-json').value             = '';
      document.getElementById('add-img-label').textContent  = 'Image…';
      document.getElementById('add-json-label').textContent = 'JSON…';
      statusEl.hidden = true;
      showManageScreen();
    } catch (e) {
      statusEl.textContent = e.message;
      statusEl.style.color = 'var(--fail)';
    } finally {
      uploadBtn.disabled = false;
    }
  });
}
