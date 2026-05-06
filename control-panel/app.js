/* ─── Control Panel Logic ────────────────────────────────────────────────── */

const WS_URL = 'ws://localhost:3001';
let ws;
let currentState = {};
let pendingLogoBlue   = null;  // base64 data URL
let pendingLogoOrange = null;
let pendingAddLogo    = null;
let editingTeamName   = null;  // null = add mode, string = edit mode

// ── Helpers ───────────────────────────────────────────────────────────────
function send(type, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, data: data || {} }));
  }
}

function el(id) { return document.getElementById(id); }

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ── Custom Modal ──────────────────────────────────────────────────────────
let modalResolve = null;

function customConfirm(title, message, confirmText = 'Confirm') {
  el('modal-title').textContent = title;
  el('modal-message').textContent = message;
  el('modal-btn-confirm').textContent = confirmText;
  el('modal-container').classList.add('active');
  
  return new Promise((resolve) => {
    modalResolve = resolve;
  });
}

function closeModal(result) {
  el('modal-container').classList.remove('active');
  if (modalResolve) modalResolve(result);
  modalResolve = null;
}

el('modal-btn-confirm').addEventListener('click', () => closeModal(true));
el('modal-btn-cancel').addEventListener('click', () => closeModal(false));
el('modal-btn-close').addEventListener('click', () => closeModal(false));

// ── Tab switching ─────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab-content').forEach(c => {
      c.classList.toggle('active', c.id === `tab-${tab}-content`);
    });
  });
});

// ── Status bar ────────────────────────────────────────────────────────────
function setStatus(connected) {
  const dot  = el('status-dot');
  const text = el('status-text');
  dot.classList.toggle('ok', connected);
  text.textContent = connected ? 'Connected to server' : 'No connection to server';
}

// ── Apply full state from server ──────────────────────────────────────────
function applyState(data) {
  currentState = data;

  // Event name
  const evEl = el('input-event');
  if (evEl && document.activeElement !== evEl) evEl.value = data.eventName || '';

  // Teams
  const teams = data.teams || {};
  syncTeamCard('blue',   teams.blue);
  syncTeamCard('orange', teams.orange);

  // Series
  el('val-series-blue').textContent   = data.series?.blue   ?? 0;
  el('val-series-orange').textContent = data.series?.orange ?? 0;
  el('val-game-number').textContent   = data.game?.number   ?? 1;

  // Best-of
  const bo = data.bestOf || 5;
  document.querySelectorAll('input[name="bestof"]').forEach(r => {
    r.checked = parseInt(r.value) === bo;
  });

  // Saved teams dropdowns + list
  populateSavedTeamsDropdowns(data.savedTeams || []);
  renderTeamsList(data.savedTeams || []);

  // RL status
  el('rl-status').textContent = data.rlConnected
    ? '🎮 RL: Connected'
    : '🎮 RL: Disconnected';

  // Font family
  if (data.fontFamily) {
    const fontSelect = el('select-font');
    if (fontSelect && document.activeElement !== fontSelect) {
      let exists = false;
      for(let i = 0; i < fontSelect.options.length; i++) {
        if (fontSelect.options[i].value === data.fontFamily) { exists = true; break; }
      }
      if (!exists) {
        const opt = document.createElement('option');
        opt.value = data.fontFamily;
        opt.textContent = data.fontFamily;
        fontSelect.appendChild(opt);
      }
      fontSelect.value = data.fontFamily;
    }
  }

  // Banner
  if (data.banner) {
    const cbVisible = el('check-banner-visible');
    if (cbVisible) cbVisible.checked = !!data.banner.visible;

    const intervalInput = el('input-banner-interval');
    if (intervalInput && document.activeElement !== intervalInput) {
      intervalInput.value = data.banner.interval || 10;
    }
    
    const imagesList = el('banner-images-list');
    if (imagesList) {
      imagesList.innerHTML = '';
      (data.banner.images || []).forEach((src, idx) => {
        const item = document.createElement('div');
        item.style = 'position: relative; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 10px; display: flex; flex-direction: column; align-items: center; gap: 10px; transition: transform 0.2s, background 0.2s;';
        
        item.onmouseenter = () => { item.style.background = 'rgba(0,0,0,0.5)'; item.style.borderColor = 'rgba(255,255,255,0.3)'; };
        item.onmouseleave = () => { item.style.background = 'rgba(0,0,0,0.3)'; item.style.borderColor = 'rgba(255,255,255,0.1)'; };

        const img = document.createElement('img');
        img.src = src;
        img.style = 'height: 60px; width: 100%; object-fit: contain; border-radius: 4px;';
        
        const btn = document.createElement('button');
        btn.className = 'btn btn-danger btn-sm';
        btn.style = 'width: 100%; padding: 4px; font-size: 12px; margin-top: auto; display: flex; align-items: center; justify-content: center; gap: 4px; border-radius: 4px; cursor: pointer; border: none; font-weight: 600; color: white; background: #c53030;';
        btn.innerHTML = '🗑️ Remove';
        btn.onmouseenter = () => { btn.style.background = '#e53e3e'; };
        btn.onmouseleave = () => { btn.style.background = '#c53030'; };
        btn.addEventListener('click', () => send('remove_banner_image', { index: idx }));
        
        item.appendChild(img);
        item.appendChild(btn);
        imagesList.appendChild(item);
      });
    }
  }
}

function syncTeamCard(side, teamData) {
  if (!teamData) return;
  const nameEl  = el(`input-name-${side}`);
  const logoImg = el(`preview-logo-${side}`);
  if (nameEl && document.activeElement !== nameEl) nameEl.value = teamData.name || '';
  if (logoImg) logoImg.src = teamData.logo || '../assets/rl.png';
  if (side === 'blue'   && !pendingLogoBlue)   pendingLogoBlue   = teamData.logo;
  if (side === 'orange' && !pendingLogoOrange) pendingLogoOrange = teamData.logo;
}

// ── Saved teams dropdowns ─────────────────────────────────────────────────
function populateSavedTeamsDropdowns(teams) {
  ['blue', 'orange'].forEach(side => {
    const sel = el(`select-saved-${side}`);
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">— Manual —</option>';
    teams.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.name;
      opt.textContent = t.name.toUpperCase();
      sel.appendChild(opt);
    });
    sel.value = cur;
  });
}

// ── Team list (Equipos tab) ───────────────────────────────────────────────
function renderTeamsList(teams) {
  const list     = el('teams-list');
  const emptyMsg = el('teams-empty');
  if (!list) return;

  // Remove existing items (keep empty-msg)
  list.querySelectorAll('.team-list-item').forEach(i => i.remove());

  emptyMsg.style.display = teams.length === 0 ? '' : 'none';

  teams.forEach(t => {
    const item = document.createElement('div');
    item.className = 'team-list-item';
    item.dataset.name = t.name;

    const logo = document.createElement('img');
    logo.className = 'team-list-logo';
    logo.src = t.logo || '../assets/rl.png';

    const name = document.createElement('div');
    name.className = 'team-list-name';
    name.textContent = t.name;

    const actions = document.createElement('div');
    actions.className = 'team-list-actions';

    const editBtn = document.createElement('button');
    editBtn.className = 'btn btn-secondary';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => startEditTeam(t));

    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-danger';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', () => deleteTeam(t.name));

    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    item.appendChild(logo);
    item.appendChild(name);
    item.appendChild(actions);
    list.appendChild(item);
  });
}

function startEditTeam(t) {
  // Switch to Teams tab if needed
  document.querySelector('[data-tab="equipos"]').click();
  editingTeamName = t.name;
  el('add-team-name').value = t.name;
  pendingAddLogo = t.logo;
  el('add-team-logo-preview').src = t.logo || '../assets/rl.png';
  el('btn-save-team').textContent = '✏️ Update Team';
}

async function deleteTeam(name) {
  const ok = await customConfirm('Delete Team', `Are you sure you want to delete the team "${name}"?`, 'Delete');
  if (ok) {
    send('delete_team', { name });
  }
}

// ── Event: Event name ─────────────────────────────────────────────────────
el('input-event').addEventListener('input', function() {
  send('set_event_name', { name: this.value });
});

// ── Event: Team logo file inputs ──────────────────────────────────────────
async function handleLogoInput(side, file) {
  if (!file) return;
  const b64 = await fileToBase64(file);
  if (side === 'blue') {
    pendingLogoBlue = b64;
    el('preview-logo-blue').src = b64;
  } else {
    pendingLogoOrange = b64;
    el('preview-logo-orange').src = b64;
  }
}

el('input-logo-blue').addEventListener('change', e => handleLogoInput('blue', e.target.files[0]));
el('input-logo-orange').addEventListener('change', e => handleLogoInput('orange', e.target.files[0]));

// ── Event: Saved team dropdowns ───────────────────────────────────────────
['blue', 'orange'].forEach(side => {
  el(`select-saved-${side}`).addEventListener('change', function() {
    const name = this.value;
    if (!name) {
      // Reset to manual/default
      if (side === 'blue') {
        pendingLogoBlue = null;
        el('preview-logo-blue').src = '../assets/rl.png';
      } else {
        pendingLogoOrange = null;
        el('preview-logo-orange').src = '../assets/rl.png';
      }
      return;
    }
    const teams = currentState.savedTeams || [];
    const t = teams.find(t => t.name === name);
    if (!t) return;
    el(`input-name-${side}`).value = t.name;
    if (side === 'blue') {
      pendingLogoBlue = t.logo;
      el('preview-logo-blue').src = t.logo || '../assets/rl.png';
    } else {
      pendingLogoOrange = t.logo;
      el('preview-logo-orange').src = t.logo || '../assets/rl.png';
    }
    // Auto-apply
    applyTeam(side);
  });
});

function applyTeam(side) {
  const name = el(`input-name-${side}`).value.trim().toUpperCase();
  if (!name) return;
  const logo = side === 'blue' ? pendingLogoBlue : pendingLogoOrange;
  send('set_team', { side, name, logo: logo || null });
}

el('btn-apply-blue').addEventListener('click', () => applyTeam('blue'));
el('btn-apply-orange').addEventListener('click', () => applyTeam('orange'));

['blue', 'orange'].forEach(side => {
  el(`input-name-${side}`).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyTeam(side);
  });
});

// ── Event: Quick save team buttons ────────────────────────────────────────
el('btn-quick-save-blue').addEventListener('click', () => {
  const name = el('input-name-blue').value.trim().toUpperCase();
  if (!name) { alert('Enter team name.'); return; }
  send('save_team', { name, logo: pendingLogoBlue || null });
});

el('btn-quick-save-orange').addEventListener('click', () => {
  const name = el('input-name-orange').value.trim().toUpperCase();
  if (!name) { alert('Enter team name.'); return; }
  send('save_team', { name, logo: pendingLogoOrange || null });
});

// ── Event: Series buttons ─────────────────────────────────────────────────
el('btn-series-blue-plus').addEventListener('click',   () => send('adjust_series', { side: 'blue',   delta: +1 }));
el('btn-series-blue-minus').addEventListener('click',  () => send('adjust_series', { side: 'blue',   delta: -1 }));
el('btn-series-orange-plus').addEventListener('click', () => send('adjust_series', { side: 'orange', delta: +1 }));
el('btn-series-orange-minus').addEventListener('click',() => send('adjust_series', { side: 'orange', delta: -1 }));

// ── Event: Game Number buttons ────────────────────────────────────────────
el('btn-game-plus').addEventListener('click',   () => send('adjust_game_number', { delta: +1 }));
el('btn-game-minus').addEventListener('click',  () => send('adjust_game_number', { delta: -1 }));
el('btn-game-reset').addEventListener('click',  () => send('set_game_number', { value: 0 }));

// ── Event: Pull Team Names from RL API ────────────────────────────────────
el('btn-pull-name-blue').addEventListener('click', () => {
  const name = currentState.gameTeams?.blue;
  if (name) {
    el('input-name-blue').value = name.toUpperCase();
    // Trigger input event to sync with server if needed
    el('input-name-blue').dispatchEvent(new Event('input'));
  }
});

el('btn-pull-name-orange').addEventListener('click', () => {
  const name = currentState.gameTeams?.orange;
  if (name) {
    el('input-name-orange').value = name.toUpperCase();
    // Trigger input event to sync with server if needed
    el('input-name-orange').dispatchEvent(new Event('input'));
  }
});

// ── Event: Best-of ────────────────────────────────────────────────────────
document.querySelectorAll('input[name="bestof"]').forEach(r => {
  r.addEventListener('change', function() {
    if (this.checked) send('set_best_of', { value: parseInt(this.value) });
  });
});

// ── Event: View controls ──────────────────────────────────────────────────
el('btn-force-scoreboard').addEventListener('click', () => send('force_scoreboard'));
el('btn-force-hud').addEventListener('click',        () => send('force_hud'));

el('btn-swap-teams').addEventListener('click', () => {
  send('swap_teams');
});

el('btn-reset-all').addEventListener('click', async () => {
  const ok = await customConfirm('Reset Data', 'Are you sure you want to reset ALL match data? This cannot be undone.', 'Reset All');
  if (ok) {
    send('reset_all');
  }
});

el('btn-default-logo-blue').addEventListener('click', () => {
  pendingLogoBlue = null;
  el('preview-logo-blue').src = '../assets/rl.png';
});

el('btn-default-logo-orange').addEventListener('click', () => {
  pendingLogoOrange = null;
  el('preview-logo-orange').src = '../assets/rl.png';
});

// ── Add team logo ─────────────────────────────────────────────────────────
el('add-team-logo').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  pendingAddLogo = await fileToBase64(file);
  el('add-team-logo-preview').src = pendingAddLogo;
});

// ── Save team ─────────────────────────────────────────────────────────────
el('btn-save-team').addEventListener('click', () => {
  const name = el('add-team-name').value.trim().toUpperCase();
  if (!name) { alert('Enter team name.'); return; }
  send('save_team', { name, logo: pendingAddLogo || null });
  resetAddTeamForm();
});

el('btn-clear-team-form').addEventListener('click', resetAddTeamForm);

function resetAddTeamForm() {
  editingTeamName = null;
  el('add-team-name').value = '';
  el('add-team-logo').value = '';
  pendingAddLogo = null;
  el('add-team-logo-preview').src = '../assets/rl.png';
  el('btn-save-team').textContent = '💾 Save Team';
}

// ── Font settings ─────────────────────────────────────────────────────────
async function loadSystemFonts() {
  const select = el('select-font');
  if (!select) return;

  try {
    const availableFonts = await window.queryLocalFonts();
    const fonts = [...new Set(availableFonts.map(f => f.family))].sort();
    
    // Clear and populate
    select.innerHTML = '';
    fonts.forEach(f => {
      const opt = document.createElement('option');
      opt.value = f;
      opt.textContent = f;
      select.appendChild(opt);
    });
    
    // Check if Bourgeois exists, we add it explicitly if needed (handled below or just selected)
    if (currentState.fontFamily) {
      // If it doesn't exist in the list, add it
      let exists = fonts.includes(currentState.fontFamily);
      if (!exists) {
        const opt = document.createElement('option');
        opt.value = currentState.fontFamily;
        opt.textContent = currentState.fontFamily;
        select.prepend(opt);
      }
      select.value = currentState.fontFamily;
    }
  } catch (err) {
    console.warn('System fonts API not available or permission denied.', err);
    // Add default fallback options if API fails
    if (select.options.length <= 1) {
      select.innerHTML = '<option value="Bourgeois">Bourgeois</option><option value="Arial">Arial</option><option value="Impact">Impact</option><option value="Verdana">Verdana</option>';
      if (currentState.fontFamily) select.value = currentState.fontFamily;
    }
  }
}

el('tab-ajustes').addEventListener('click', async () => {
  await loadSystemFonts();
});

el('select-font').addEventListener('change', function() {
  send('set_font_family', { fontFamily: this.value });
});

// ── Banner Settings ───────────────────────────────────────────────────────
el('check-banner-visible').addEventListener('change', function() {
  send('set_banner_visibility', { visible: this.checked });
});

el('input-banner-interval').addEventListener('change', function() {
  send('set_banner_interval', { interval: parseInt(this.value) || 10 });
});

el('input-banner-image').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const b64 = await fileToBase64(file);
  send('add_banner_image', { image: b64 });
  // clear input so we can select same file again if needed
  e.target.value = '';
});

// ── RL status ─────────────────────────────────────────────────────────────
// (Updated via full_state)

// ── WebSocket ─────────────────────────────────────────────────────────────
function connect() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    setStatus(true);
    send('request_state');
  };

  ws.onmessage = ({ data }) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    if (msg.type === 'full_state') {
      applyState(msg.data);
    } else if (msg.type === 'rl_status') {
      el('rl-status').textContent = msg.data.connected
        ? '🎮 RL: Connected'
        : '🎮 RL: Disconnected';
    }
  };

  ws.onclose = () => {
    setStatus(false);
    setTimeout(connect, 3000);
  };

  ws.onerror = () => ws.close();
}

connect();
