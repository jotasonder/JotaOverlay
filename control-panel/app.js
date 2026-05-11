/* ─── Control Panel Logic ────────────────────────────────────────────────── */

const WS_URL = 'ws://localhost:3001';
let ws;
let currentState = {};
let pendingLogoBlue   = null;  // base64 data URL
let pendingLogoOrange = null;
let pendingAddLogo    = null;
let editingTeamName   = null;  // null = add mode, string = edit mode
let _lastPlayerKey    = '';    // guard to avoid unnecessary select rebuilds
let updateBannerDismissed = false; 

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
  syncFacecamRows(data.players || [], data.facecams || [], true);
  renderSavedFacecams(data.facecams || []);

  // RL status
  el('rl-status').textContent = data.rlConnected
    ? '🎮 RL: Connected'
    : '🎮 RL: Disconnected';

  // Facecams enabled
  const cbFacecams = el('check-facecams-enabled');
  if (cbFacecams) cbFacecams.checked = data.facecamsEnabled !== false;
  
  const facecamsWarning = el('facecams-disabled-warning');
  if (facecamsWarning) {
    facecamsWarning.style.display = (data.facecamsEnabled === false) ? 'flex' : 'none';
  }

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
  // Version
  if (data.version) {
    const verEl = el('app-version');
    if (verEl) verEl.textContent = data.version;
  }

  // Update notification
  const updateBanner = el('update-notification');
  if (updateBanner) {
    if (data.updateAvailable && !updateBannerDismissed) {
      el('update-version-tag').textContent = data.updateAvailable.version;
      el('update-link').href = data.updateAvailable.url;
      updateBanner.style.display = 'flex';
    } else {
      updateBanner.style.display = 'none';
    }
  }

  // Updates settings
  const cbUpdateAlerts = el('check-update-alerts');
  if (cbUpdateAlerts) cbUpdateAlerts.checked = data.updateChecksEnabled !== false;
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

    const handle = document.createElement('div');
    handle.className = 'drag-handle';
    handle.textContent = '⋮⋮';
    handle.title = 'Drag to reorder';

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
    
    item.appendChild(handle);
    item.appendChild(logo);
    item.appendChild(name);
    item.appendChild(actions);
    list.appendChild(item);
  });

  // Init Sortable if not already done or just refresh
  if (window.Sortable && list.childElementCount > 1) {
    if (list._sortable) list._sortable.destroy();
    list._sortable = Sortable.create(list, {
      handle: '.drag-handle',
      animation: 150,
      ghostClass: 'sortable-ghost',
      onEnd: () => {
        const newOrderNames = Array.from(list.querySelectorAll('.team-list-item')).map(el => el.dataset.name);
        const reordered = newOrderNames.map(name => currentState.savedTeams.find(st => st.name === name));
        send('update_teams_order', { teams: reordered });
      }
    });
  }
}

el('btn-sort-teams-abc').addEventListener('click', () => {
  if (!currentState.savedTeams || currentState.savedTeams.length <= 1) return;
  const sorted = [...currentState.savedTeams].sort((a, b) => a.name.localeCompare(b.name));
  send('update_teams_order', { teams: sorted });
});

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

function renderSavedFacecams(facecams) {
  const list = el('facecams-list');
  const emptyMsg = el('facecams-empty');
  if (!list || !emptyMsg) return;

  const items = list.querySelectorAll('.facecam-list-item');
  items.forEach(it => it.remove());

  emptyMsg.style.display = facecams.length === 0 ? '' : 'none';

  facecams.forEach(fc => {
    const item = document.createElement('div');
    item.className = 'facecam-list-item';

    // 1st Row: [Logo] NICKNAME [Delete]
    const row1 = document.createElement('div');
    row1.className = 'facecam-top-row';
    row1.style.marginBottom = '4px';

    const leftGroup = document.createElement('div');
    leftGroup.style.display = 'flex';
    leftGroup.style.alignItems = 'center';
    leftGroup.style.gap = '8px';
    leftGroup.style.flex = '1';

    const platImg = document.createElement('img');
    platImg.className = 'facecam-platform-logo';
    const isBot = !fc.platform || fc.platform === 'none' || fc.platform === 'bot';
    platImg.src = isBot ? '../assets/rl.png' : `../assets/platforms/${fc.platform}.png`;
    platImg.onerror = () => { platImg.src = '../assets/rl.png'; }; // fallback

    const nickInput = document.createElement('input');
    nickInput.type = 'text';
    nickInput.className = 'input-text';
    nickInput.style.flex = '1';
    nickInput.style.fontSize = '12px';
    nickInput.style.height = '28px';
    nickInput.style.fontWeight = '700';
    nickInput.style.background = 'transparent';
    nickInput.style.border = 'none';
    nickInput.style.padding = '0';
    nickInput.value = fc.nickname || fc.name;
    nickInput.placeholder = 'NICKNAME...';

    leftGroup.appendChild(platImg);
    leftGroup.appendChild(nickInput);

    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-danger btn-sm';
    delBtn.style.padding = '4px 8px';
    delBtn.innerHTML = '✕';
    delBtn.addEventListener('click', async () => {
      const ok = await customConfirm('Delete Facecam', `Delete saved configuration for "${fc.name}"?`, 'Delete');
      if (ok) send('delete_facecam', { name: fc.name });
    });

    row1.appendChild(leftGroup);
    row1.appendChild(delBtn);

    // 2nd Row: Name/ID info
    const row2 = document.createElement('div');
    row2.className = 'facecam-list-steam-id';
    row2.style.marginBottom = '8px';
    row2.style.opacity = '0.5';
    row2.textContent = (fc.platformId && fc.platformId !== fc.name) 
      ? `${fc.name} (${fc.platformId})` 
      : fc.name;

    // 3rd Row: URL [Save]
    const row3 = document.createElement('div');
    row3.className = 'facecam-middle-row';
    row3.style.gap = '6px';

    const urlInp = document.createElement('input');
    urlInp.type = 'text';
    urlInp.className = 'input-text';
    urlInp.style.flex = '1';
    urlInp.style.fontSize = '11px';
    urlInp.style.height = '32px';
    urlInp.value = fc.link || '';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-secondary btn-sm';
    saveBtn.textContent = '💾';
    saveBtn.title = 'Save changes';
    saveBtn.addEventListener('click', () => {
      const newLink = urlInp.value.trim();
      const newNick = nickInput.value.trim();
      send('save_facecam', {
        name: fc.name,
        platform: fc.platform,
        platformId: fc.platformId,
        link: newLink,
        nickname: newNick
      });
    });

    row3.appendChild(urlInp);
    row3.appendChild(saveBtn);

    item.appendChild(row1);
    item.appendChild(row2);
    item.appendChild(row3);
    list.appendChild(item);
  });
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
  send('save_team', { name, logo: pendingAddLogo || null, oldName: editingTeamName });
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

el('check-facecams-enabled').addEventListener('change', function() {
  send('set_facecams_enabled', { enabled: this.checked });
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

// ── Update Notification dismissal ─────────────────────────────────────────
el('btn-dismiss-update').addEventListener('click', () => {
  updateBannerDismissed = true;
  el('update-notification').style.display = 'none';
});

el('check-update-alerts').addEventListener('change', function() {
  send('set_update_checks_enabled', { enabled: this.checked });
});

// ── Facecams: mode selector & grid logic ─────────────────────────────────
let facecamMode = 3; // default 3v3

const PLATFORMS = [
  { key: 'steam',       label: 'Steam'       },
  { key: 'epic',        label: 'Epic'        },
  { key: 'playstation', label: 'PlayStation' },
  { key: 'xbox',        label: 'Xbox'        },
  { key: 'nintendo',    label: 'Nintendo'    }
];

function updateFacecamRows(mode) {
  ['blue', 'orange'].forEach(side => {
    for (let i = 0; i < 4; i++) {
      const row = el(`fcrow-${side}-${i}`);
      if (row) row.style.display = i < mode ? '' : 'none';
    }
  });
}

document.querySelectorAll('input[name="fcmode"]').forEach(r => {
  r.addEventListener('change', function() {
    if (this.checked) {
      facecamMode = parseInt(this.value);
      updateFacecamRows(facecamMode);
    }
  });
});

function updateFacecamDropdowns(players) {
  // Between matches players = [] — keep existing dropdown state, don't wipe it
  if (!players || players.length === 0) return;

  const blue   = players.filter(p => p.team === 0).sort((a,b) => a.name.localeCompare(b.name));
  const orange = players.filter(p => p.team === 1).sort((a,b) => a.name.localeCompare(b.name));

  // ── Guard: skip DOM rebuild if player list hasn't changed (prevents focus loss)
  const newKey = [...blue, ...orange].map(p => p.name).join('|');
  const needsRebuild = newKey !== _lastPlayerKey;
  _lastPlayerKey = newKey;

  // Auto-detect mode from active player count
  const detected = Math.min(Math.max(blue.length, orange.length, 1), 4);
  if ((blue.length > 0 || orange.length > 0) && detected !== facecamMode) {
    facecamMode = detected;
    document.querySelectorAll('input[name="fcmode"]').forEach(r => {
      r.checked = parseInt(r.value) === facecamMode;
    });
    updateFacecamRows(facecamMode);
  }

  if (!needsRebuild) return false; // Don't touch the DOM if nothing changed

  function populateSide(side, list) {
    for (let i = 0; i < 4; i++) {
      const sel = el(`fc-${side}-${i}-name`);
      if (!sel || document.activeElement === sel) continue; // never rebuild focused select
      const current = sel.value;
      sel.innerHTML = '<option value="">— Select —</option>';
      list.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.name;
        opt.textContent = p.name;
        sel.appendChild(opt);
      });
      if (current && list.find(p => p.name === current)) sel.value = current;
    }
  }

  populateSide('blue', blue);
  populateSide('orange', orange);
  return true;
}

function syncFacecamRows(players, savedFacecams, forceSync = false) {
  const playersChanged = updateFacecamDropdowns(players);
  
  // If players haven't changed and we are not forcing sync (e.g. initial load or after save),
  // do NOT touch the inputs. This prevents clearing fields while the user is typing.
  if (!playersChanged && !forceSync) return;

  const blue   = players.filter(p => p.team === 0).sort((a,b) => a.name.localeCompare(b.name));
  const orange = players.filter(p => p.team === 1).sort((a,b) => a.name.localeCompare(b.name));

  function syncSide(side, list) {
    list.forEach((p, i) => {
      if (i >= 4) return;
      const rawId = p.primaryid ? String(p.primaryid).split('|')[1] || '' : '';
      
      // Prioritize ID lookup, fallback to Name
      let saved = null;
      if (rawId) saved = savedFacecams.find(fc => fc.platformId && fc.platformId === rawId);
      if (!saved) saved = savedFacecams.find(fc => fc.name === p.name);

      // Player name dropdown
      const sel = el(`fc-${side}-${i}-name`);
      if (sel && p.name && document.activeElement !== sel) sel.value = p.name;

      // Always set ID and URL — clear them if no saved facecam for this player
      const idEl = el(`fc-${side}-${i}-id`);
      if (idEl && document.activeElement !== idEl)
        idEl.value = saved ? (saved.platformId || '') : '';

      const urlEl = el(`fc-${side}-${i}-url`);
      if (urlEl && document.activeElement !== urlEl)
        urlEl.value = saved ? (saved.link || '') : '';

      // Platform picker — reset to steam if no saved facecam
      const platform = (saved && saved.platform) ? saved.platform : 'steam';
      const picker = el(`fc-${side}-${i}-platform`);
      if (picker) {
        picker.querySelectorAll('.plat-icon').forEach(icon => {
          icon.classList.toggle('selected', icon.dataset.platform === platform);
        });
        picker.dataset.value = platform;
      }

      // Update preview
      const previewWrap   = el(`fc-${side}-${i}-preview-wrap`);
      const previewIframe = el(`fc-${side}-${i}-preview`);
      const previewToggle = el(`fc-${side}-${i}-preview-toggle`);
      
      if (previewWrap && previewIframe && previewToggle) {
        if (saved && saved.link) {
          // Store the URL for lazy loading
          previewIframe.dataset.src = saved.link;
          previewToggle.style.display = '';
          
          // If it's already open, sync the src
          if (previewWrap.classList.contains('open') && previewIframe.src !== saved.link) {
            previewIframe.src = saved.link;
          }
        } else {
          previewIframe.src = 'about:blank';
          previewIframe.dataset.src = '';
          previewToggle.style.display = 'none';
          previewWrap.classList.remove('open');
          previewToggle.classList.remove('open');
        }
      }
    });
  }

  syncSide('blue', blue);
  syncSide('orange', orange);
}

// ── Facecams: manual add ──────────────────────────────────────────────────
el('btn-add-facecam-manual').addEventListener('click', () => {
  const name     = el('add-fc-name').value.trim();
  const platform = el('add-fc-platform').value;
  const link     = el('add-fc-url').value.trim();
  
  if (!name || !link) {
    alert('Please enter both a Name/ID and a URL.');
    return;
  }

  send('save_facecam', {
    name,
    platform,
    platformId: name, // Default platformId to name for manual entries
    link
  });

  // Clear inputs
  el('add-fc-name').value = '';
  el('add-fc-url').value = '';
});


function applyFacecamRow(side, idx) {
  const nameEl     = el(`fc-${side}-${idx}-name`);
  const platformEl = el(`fc-${side}-${idx}-platform`);
  const idEl       = el(`fc-${side}-${idx}-id`);
  const urlEl      = el(`fc-${side}-${idx}-url`);
  const name       = nameEl     ? nameEl.value.trim()                    : '';
  const platform   = platformEl ? (platformEl.dataset.value || 'steam')  : 'steam';
  const platformId = idEl       ? idEl.value.trim()                      : '';
  const link       = urlEl      ? urlEl.value.trim()                     : '';
  if (!name && !platformId) { alert('Select a player or enter a Primary ID.'); return; }
  if (!link) { alert('Enter the facecam URL.'); return; }
  const key = name || platformId;
  send('save_facecam', { name: key, platform, platformId: platformId || null, link });
  
  // Refresh preview immediately and open it
  const previewWrap   = el(`fc-${side}-${idx}-preview-wrap`);
  const previewIframe = el(`fc-${side}-${idx}-preview`);
  const previewToggle = el(`fc-${side}-${idx}-preview-toggle`);
  
  if (previewWrap && previewIframe && previewToggle) {
    previewIframe.dataset.src = link;
    previewIframe.src = link;
    previewToggle.style.display = '';
    previewToggle.classList.add('open');
    previewWrap.classList.add('open');
    const span = previewToggle.querySelector('span');
    if (span) span.textContent = 'Hide Preview';
  }
}

function deleteFacecamRow(side, idx) {
  const nameEl     = el(`fc-${side}-${idx}-name`);
  const idEl       = el(`fc-${side}-${idx}-id`);
  const urlEl      = el(`fc-${side}-${idx}-url`);
  const name       = nameEl ? nameEl.value.trim() : '';
  const platformId = idEl   ? idEl.value.trim()   : '';
  
  const key = name || platformId;
  if (key) {
    send('delete_facecam', { name: key });
  }

  // Clear fields
  if (urlEl) urlEl.value = '';
  if (idEl && !name) idEl.value = ''; // only clear ID if not selected via name

  // Hide preview
  const previewWrap   = el(`fc-${side}-${idx}-preview-wrap`);
  const previewIframe = el(`fc-${side}-${idx}-preview`);
  const previewToggle = el(`fc-${side}-${idx}-preview-toggle`);
  if (previewWrap && previewIframe && previewToggle) {
    previewIframe.src = 'about:blank';
    previewIframe.dataset.src = '';
    previewToggle.style.display = 'none';
    previewWrap.classList.remove('open');
    previewToggle.classList.remove('open');
  }
}


// ── Platform pickers (generated via JS to avoid repeating HTML 8 times) ──────
function initPlatformPickers() {
  ['blue', 'orange'].forEach(side => {
    for (let i = 0; i < 4; i++) {
      const idInput = el(`fc-${side}-${i}-id`);
      if (!idInput) continue;
      const fieldRow = idInput.closest('.field-row');
      if (!fieldRow) continue;

      // Update label
      const lbl = fieldRow.querySelector('.field-label');
      if (lbl) lbl.innerHTML = 'Platform & Primary ID <span style="opacity:0.45;font-weight:400;">(optional)</span>';

      // Build picker
      const picker = document.createElement('div');
      picker.className = 'platform-picker';
      picker.id = `fc-${side}-${i}-platform`;
      picker.dataset.value = 'steam';
      PLATFORMS.forEach((p, pi) => {
        const img = document.createElement('img');
        img.src = `../assets/platforms/${p.key}.png`;
        img.className = 'plat-icon' + (pi === 0 ? ' selected' : '');
        img.title = p.label;
        img.dataset.platform = p.key;
        img.addEventListener('click', () => {
          picker.querySelectorAll('.plat-icon').forEach(ic => ic.classList.remove('selected'));
          img.classList.add('selected');
          picker.dataset.value = p.key;
        });
        picker.appendChild(img);
      });

      // Wrap picker + input side-by-side
      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'display:flex; gap:6px; align-items:center;';
      fieldRow.removeChild(idInput);
      idInput.style.flex = '1';
      wrapper.appendChild(picker);
      wrapper.appendChild(idInput);
      fieldRow.appendChild(wrapper);
    }
  });
}

// ── Facecam live previews ────────────────────────────────────────────
function initFacecamPreviews() {
  ['blue', 'orange'].forEach(side => {
    for (let i = 0; i < 4; i++) {
      const row = el(`fcrow-${side}-${i}`);
      if (!row) continue;
      const btn = row.querySelector('.btn');
      if (!btn) continue;

      // Create toggle
      const toggle = document.createElement('div');
      toggle.className = 'fc-preview-toggle';
      toggle.id = `fc-${side}-${i}-preview-toggle`;
      toggle.innerHTML = '<span>Show Preview</span>';
      toggle.style.display = 'none';

      // Create wrap
      const wrap = document.createElement('div');
      wrap.className = 'fc-preview-wrap';
      wrap.id = `fc-${side}-${i}-preview-wrap`;

      const iframe = document.createElement('iframe');
      iframe.id = `fc-${side}-${i}-preview`;
      iframe.className = 'fc-preview-iframe';
      iframe.frameBorder = '0';
      iframe.allow = 'autoplay; encrypted-media';
      iframe.loading = 'lazy';
      iframe.referrerPolicy = 'no-referrer';
      iframe.src = 'about:blank';

      wrap.appendChild(iframe);

      // Toggle logic
      toggle.addEventListener('click', () => {
        const isOpen = wrap.classList.toggle('open');
        toggle.classList.toggle('open', isOpen);
        toggle.querySelector('span').textContent = isOpen ? 'Hide Preview' : 'Show Preview';
        
        // Lazy load src on open
        if (isOpen && (iframe.src === 'about:blank' || iframe.src === '')) {
          const urlVal = el(`fc-${side}-${i}-url`).value.trim();
          const target = iframe.dataset.src || urlVal;
          if (target) iframe.src = target;
        }
      });

      // ── Add Delete Button next to URL input
      const urlInput = el(`fc-${side}-${i}-url`);
      if (urlInput) {
        const urlRow = urlInput.parentElement;
        if (urlRow && urlRow.classList.contains('field-row')) {
          const wrapper = document.createElement('div');
          wrapper.style.cssText = 'display:flex; gap:6px; align-items:center;';
          urlRow.removeChild(urlInput);
          urlInput.style.flex = '1';
          
          const delBtn = document.createElement('div');
          delBtn.className = 'btn-delete-fc';
          delBtn.innerHTML = '✕';
          delBtn.title = 'Delete Facecam';
          delBtn.addEventListener('click', () => deleteFacecamRow(side, i));
          
          wrapper.appendChild(urlInput);
          wrapper.appendChild(delBtn);
          urlRow.appendChild(wrapper);
        }
      }

      // Rearrange: Insert toggle and wrap before the button
      // This puts the button at the very bottom of the row
      btn.insertAdjacentElement('beforebegin', toggle);
      btn.insertAdjacentElement('beforebegin', wrap);
      
      // Add a bit of margin to the button to separate it from the preview
      btn.style.marginTop = '10px';
    }
  });
}

// Initialise on load
updateFacecamRows(facecamMode);
initPlatformPickers();
initFacecamPreviews();

// ── Apply All Facecams ────────────────────────────────────────────────────
el('btn-apply-all-facecams').addEventListener('click', () => {
  let saved = 0;
  ['blue', 'orange'].forEach(side => {
    for (let i = 0; i < facecamMode; i++) {
      const nameEl = el(`fc-${side}-${i}-name`);
      const idEl   = el(`fc-${side}-${i}-id`);
      const urlEl  = el(`fc-${side}-${i}-url`);
      const name       = nameEl ? nameEl.value.trim() : '';
      const platformId = idEl   ? idEl.value.trim()   : '';
      const link       = urlEl  ? urlEl.value.trim()   : '';
      if ((name || platformId) && link) {
        applyFacecamRow(side, i);
        saved++;
      }
    }
  });
  if (saved === 0) alert('No facecams to apply — fill in at least one URL.');
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
    } else if (msg.type === 'state_update') {
      // Sync facecam grid live as players join — skip when between matches (empty array)
      if (msg.data.players && msg.data.players.length > 0) {
        syncFacecamRows(msg.data.players, msg.data.facecams || []);
      }
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
