const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const AdmZip = require('adm-zip');
const { dialog } = require('electron');

const HTTP_PORT = 3000;
const WS_PORT = 3001;
const RL_WS_URL = 'ws://localhost:49122';
const RL_RECONNECT_INTERVAL = 3000;

let appDir = __dirname;
let dataDir;
let teamsFile;
let stateFile;
let facecamsFile;

let assetsDir;

let presetsDir;
let presetsFile;
let savedPresets = [];   // [{ name, slug, assets }]


// Overlay assets that can be overridden from the control panel.
// Acts as a whitelist — anything not listed is rejected.
const ASSET_NAMES = [
  'scoreboard.png', 'podium-scoreboard2.png', 'podium-full.png',
  'boost.png', 'boost-tags.png', 'banner.png',
  'player.png', 'player-blue.png', 'player-orange.png',
  'player-blue-bot.png', 'player-orange-bot.png',
  'goal-blue-2.png', 'goal-orange-2.png', 'mvp.png'
];

let appVersion = '0.0.0';
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  appVersion = pkg.version;
} catch (e) { console.error('Error reading package.json version:', e); }

// ─── State ───────────────────────────────────────────────────────────────────
let state = {
  version: appVersion,
  view: 'hud',              // 'hud' | 'scoreboard' | 'goal'
  eventName: 'ROCKET LEAGUE TOURNAMENT',
  fontFamily: 'Bourgeois',
  facecamsEnabled: true,
  banner: { visible: false, images: [], interval: 10 },
  assets: {},
  activePreset: null, 
  bestOf: 5,
  teams: {
    blue:   { name: 'BLUE TEAM',   logo: null },
    orange: { name: 'ORANGE TEAM', logo: null }
  },
  series:  { blue: 0, orange: 0 },
  game:    { blueScore: 0, orangeScore: 0, time: 300, isOT: false, number: 1 },
  gameTeams: { blue: '', orange: '' },
  players: [],          // active players (from last UpdateState)
  playerCache: {},      // all players seen (keyed by name) — for scoreboard
  currentGoal: null,    // { scorer, assister, speed, team }
  spectatedPlayer: null,
  rlConnected: false,
  updateAvailable: null,    // { version, url }
  updateChecksEnabled: true
};

let savedTeams = [];   // [{ name, logo }]
let savedFacecams = []; // [{ name, platformId, link }]

// ─── Helpers ─────────────────────────────────────────────────────────────────
function loadTeams() {
  try {
    if (fs.existsSync(teamsFile)) {
      savedTeams = JSON.parse(fs.readFileSync(teamsFile, 'utf8'));
    }
  } catch (e) { savedTeams = []; }
}

function saveTeams() {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(teamsFile, JSON.stringify(savedTeams, null, 2));
  } catch (e) { console.error('Error saving teams:', e); }
}

function loadFacecams() {
  try {
    if (fs.existsSync(facecamsFile)) {
      savedFacecams = JSON.parse(fs.readFileSync(facecamsFile, 'utf8'));
    }
  } catch (e) { savedFacecams = []; }
}

function saveFacecams() {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(facecamsFile, JSON.stringify(savedFacecams, null, 2));
  } catch (e) { console.error('Error saving facecams:', e); }
}


function loadPresets() {
  try {
    if (fs.existsSync(presetsFile)) {
      savedPresets = JSON.parse(fs.readFileSync(presetsFile, 'utf8'));
    }
  } catch (e) { savedPresets = []; }
}

function savePresets() {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(presetsFile, JSON.stringify(savedPresets, null, 2));
  } catch (e) { console.error('Error saving presets:', e); }
}

// Preset names become folder names, so strip anything a filesystem won't take.
function slugify(name) {
  return String(name).trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}



function loadState() {
  try {
    if (fs.existsSync(stateFile)) {
      const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (saved.eventName) state.eventName = saved.eventName;
      if (saved.fontFamily) state.fontFamily = saved.fontFamily;
      if (saved.facecamsEnabled !== undefined) state.facecamsEnabled = saved.facecamsEnabled;
      if (saved.banner) state.banner = saved.banner;
      if (saved.assets) state.assets = saved.assets;
      if (saved.activePreset) state.activePreset = saved.activePreset;
      if (saved.bestOf) state.bestOf = saved.bestOf;
      if (saved.teams) state.teams = saved.teams;
      if (saved.series) state.series = saved.series;
      if (saved.game && typeof saved.game.number === 'number') {
        state.game.number = saved.game.number;
      }
      if (saved.updateChecksEnabled !== undefined) {
        state.updateChecksEnabled = saved.updateChecksEnabled;
      }
    }
  } catch (e) { console.error('Error loading state:', e); }
}

function saveAppState() {
  try {
    const toSave = {
      eventName: state.eventName,
      fontFamily: state.fontFamily,
      facecamsEnabled: state.facecamsEnabled,
      banner: state.banner,
      assets: state.assets,
      activePreset: state.activePreset,
      bestOf: state.bestOf,
      teams: state.teams,
      series: state.series,
      game: { number: state.game.number },
      updateChecksEnabled: state.updateChecksEnabled
    };
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(toSave, null, 2));
  } catch (e) { console.error('Error saving state:', e); }
}

function broadcast(clients, msg) {
  const str = JSON.stringify(msg);
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(str);
  });
}

function formatTime(seconds) {
  if (seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function getFullState() {
  return {
    type: 'full_state',
    data: {
      ...state,
      savedTeams,
      facecams: savedFacecams,
      presets: savedPresets,
      formattedTime: formatTime(state.game.time)
    }
  };
}

function isNewerVersion(remote, local) {
  const r = remote.replace(/^v/, '').split('.').map(Number);
  const l = local.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((r[i] || 0) > (l[i] || 0)) return true;
    if ((r[i] || 0) < (l[i] || 0)) return false;
  }
  return false;
}

async function checkForUpdates() {
  if (!state.updateChecksEnabled) return;
  try {
    const repo = 'jotasonder/JotaOverlay';
    const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { 'User-Agent': 'JotaOverlay-Updater' }
    });
    if (!response.ok) return;
    
    const data = await response.json();
    const remoteVersion = data.tag_name; // e.g. "v0.2.1"
    
    if (isNewerVersion(remoteVersion, appVersion)) {
      state.updateAvailable = {
        version: remoteVersion,
        url: data.html_url
      };
      console.log(`[Update] New version available: ${remoteVersion}`);
      broadcastFullState();
    }
  } catch (e) {
    console.error('[Update] Error checking for updates:', e);
  }
}

// ─── RL TCP Client ─────────────────────────────────────────────────────────────
const net = require('net');
let rlSocket = null;
let bridgeClients = new Set();
let rlBuffer = '';

function connectToRL() {
  if (rlSocket) return;
  
  rlSocket = new net.Socket();
  
  rlSocket.connect(49123, '127.0.0.1', () => {
    console.log('[RL] Connected to Stats API (TCP)');
    state.rlConnected = true;
    broadcast(bridgeClients, { type: 'rl_status', data: { connected: true } });
  });

  rlSocket.on('data', (data) => {
    rlBuffer += data.toString();
    
    // Split by contiguous JSON objects
    const chunks = rlBuffer.replace(/\}\s*\{/g, '}\n{').split('\n');
    rlBuffer = chunks.pop(); // keep the last incomplete chunk
    
    chunks.forEach(chunk => {
      chunk = chunk.trim();
      if (!chunk) return;
      try {
        const msg = JSON.parse(chunk);
        handleRLEvent(msg);
      } catch (e) {
        // If it fails to parse, it might be incomplete. We should prepend it back.
        // But since we split by }\n{, it should be complete unless the split failed.
        // For simplicity, we just ignore broken packets.
      }
    });
  });

  rlSocket.on('close', () => {
    console.log('[RL] Disconnected from Stats API');
    state.rlConnected = false;
    rlSocket = null;
    broadcast(bridgeClients, { type: 'rl_status', data: { connected: false } });
    scheduleRLReconnect();
  });

  rlSocket.on('error', () => {
    rlSocket = null;
    scheduleRLReconnect();
  });
}

function scheduleRLReconnect() {
  setTimeout(connectToRL, RL_RECONNECT_INTERVAL);
}

function handleRLEvent(msg) {
  const event = msg.Event || msg.event || '';
  let data  = msg.Data  || msg.data  || {};

  // DefaultStatsAPI sometimes stringifies the Data field
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch (e) { }
  }

  switch (event) {
    case 'UpdateState':
    case 'game:update_state':
      handleUpdateState(data);
      break;
    case 'GoalScored':
    case 'game:goal_scored':
      handleGoalScored(data);
      break;
    case 'ClockUpdatedSeconds':
      handleClock(data);
      break;
    case 'GoalReplayStart':
    case 'ReplayStart':
    case 'game:replay_start':
      handleGoalReplayStart();
      break;
    case 'GoalReplayEnd':
    case 'ReplayEnd':
    case 'game:replay_end':
      handleGoalReplayEnd();
      break;
    case 'MatchEnded':
    case 'game:match_ended':
      handleMatchEnded(data);
      break;
    case 'MatchCreated':
    case 'game:match_created':
      handleMatchCreated(data);
      break;
    default:
      break;
  }
}

function handleClock(data) {
  if ('TimeSeconds' in data) state.game.time = data.TimeSeconds;
  else if ('time_seconds' in data) state.game.time = data.time_seconds;
  
  if ('bOvertime' in data) state.game.isOT = data.bOvertime;
  
  // If the clock ticks, we are definitely not in a replay anymore.
  if (state.view === 'goal') {
    handleGoalReplayEnd();
  }

  // Broadcast the new time to clients
  broadcast(bridgeClients, {
    type: 'state_update',
    data: {
      game: { ...state.game, formattedTime: formatTime(state.game.time) },
      players: state.players,
      spectatedPlayer: state.spectatedPlayer,
      facecams: savedFacecams
    }
  });
}

function handleUpdateState(data) {
  const game = data.Game || data.game || {};
  const players = data.Players || data.players || [];

  // Update game
  if ('SecondsRemaining' in game) state.game.time = game.SecondsRemaining;
  else if ('time_seconds' in game) state.game.time = game.time_seconds;
  
  if ('IsOT' in game) state.game.isOT = game.IsOT;
  else if ('isOT' in game) state.game.isOT = game.isOT;

  // Scores from teams array or direct fields
  const teams = game.Teams || game.teams || [];
  if (teams.length >= 2) {
    teams.forEach(t => {
      if ((t.TeamNum === 0 || t.teamNum === 0)) {
        state.game.blueScore   = t.Score ?? t.score ?? 0;
        state.gameTeams.blue   = t.Name || t.name || 'BLUE';
      }
      if ((t.TeamNum === 1 || t.teamNum === 1)) {
        state.game.orangeScore = t.Score ?? t.score ?? 0;
        state.gameTeams.orange = t.Name || t.name || 'ORANGE';
      }
    });
  } else {
    if ('BlueScore'   in game) state.game.blueScore   = game.BlueScore;
    if ('OrangeScore' in game) state.game.orangeScore = game.OrangeScore;
  }

  // Players — normalise field names
  const normalised = players.map(p => ({
    name:    p.Name    || p.name    || '?',
    primaryid: p.PrimaryId ?? p.primaryId ?? null,
    team:    p.TeamNum ?? p.teamNum ?? 0,
    score:   p.Score   ?? p.score   ?? 0,
    goals:   p.Goals   ?? p.goals   ?? 0,
    assists: p.Assists ?? p.assists ?? 0,
    saves:   p.Saves   ?? p.saves   ?? 0,
    shots:   p.Shots   ?? p.shots   ?? 0,
    demos:   p.Demos   ?? p.demos   ?? 0,
    boost:   p.Boost   ?? p.boost   ?? null,
    isPrimary: p.IsPrimary ?? p.isPrimary ?? false,
    isDemolished: p.bDemolished ?? p.isDemolished ?? false
  }));

  state.players = normalised;

  // Update playerCache (persist players across game/disconnect)
  normalised.forEach(p => {
    state.playerCache[p.name] = { ...p };
  });

  // Detect spectated player
  let spec = null;
  if (game.bHasTarget !== false && game.Target) {
    spec = game.Target.Name || game.Target.name || null;
  }
  
  if (spec) {
    state.spectatedPlayer = spec;
  } else {
    // fallback to isPrimary
    const primary = normalised.find(p => p.isPrimary);
    if (primary) state.spectatedPlayer = primary.name;
    else state.spectatedPlayer = null;
  }

  // Detect transition to replay to trigger goal banner if not already shown
  if (game.bReplay === true && !state.inReplay && state.currentGoal && state.view !== 'goal') {
    handleGoalReplayStart();
  }

  // Track replay state so we don't prematurely close the goal banner
  if (game.bReplay === true) {
    state.inReplay = true;
  } else if (game.bReplay === false && state.inReplay) {
    state.inReplay = false;
    if (state.view === 'goal') {
      handleGoalReplayEnd();
    }
  }

  // Broadcast state to all clients
  broadcast(bridgeClients, {
    type: 'state_update',
    data: {
      game: { ...state.game, formattedTime: formatTime(state.game.time) },
      players: normalised,
      spectatedPlayer: state.spectatedPlayer,
      facecams: savedFacecams
    }
  });
}

function handleGoalScored(data) {
  const scorer   = data.Scorer   || data.scorer   || {};
  const assister = data.Assister || data.assister || null;
  const speed    = data.GoalSpeedKPH ?? data.goalSpeedKPH ?? data.GoalSpeed ?? data.goalSpeed ?? 0;
  const team     = scorer.TeamNum ?? scorer.teamNum ?? scorer.team ?? data.teamnum ?? 0;

  state.currentGoal = {
    scorer:   scorer.Name   || scorer.name   || '',
    assisterName: assister ? (assister.Name || assister.name || '') : null,
    speed:    Math.round(speed),
    team:     team
  };
}

function handleGoalReplayStart() {
  if (state.currentGoal) {
    state.view = 'goal';
    broadcast(bridgeClients, { type: 'view_change', data: { view: 'goal', goal: state.currentGoal } });
  }
}

function handleGoalReplayEnd() {
  state.view = 'hud';
  state.currentGoal = null;
  broadcast(bridgeClients, { type: 'view_change', data: { view: 'hud' } });
}

function handleMatchEnded(data) {
  // Determine winner by score (more reliable than relying on potentially missing fields)
  if (state.game.blueScore > state.game.orangeScore) {
    state.series.blue++;
  } else if (state.game.orangeScore > state.game.blueScore) {
    state.series.orange++;
  }
  
  saveAppState();
  broadcastFullState();

  setTimeout(() => {
    // Freeze playerCache as final scoreboard data
    state.view = 'scoreboard';
    broadcast(bridgeClients, {
      type: 'view_change',
      data: {
        view: 'scoreboard',
        series: state.series,
        playerCache: state.playerCache
      }
    });
  }, 3000);
}

function handleMatchCreated(data) {
  // New game starts — reset game data but keep series
  state.game.blueScore   = 0;
  state.game.orangeScore = 0;
  state.game.time        = 300;
  state.game.isOT        = false;
  if (state.series.blue !== 0 || state.series.orange !== 0) {
    state.game.number++;
  }
  state.players    = [];
  state.playerCache = {};
  state.view       = 'hud';
  saveAppState();
  broadcastFullState();
  broadcast(bridgeClients, { type: 'game_reset', data: { gameNumber: state.game.number } });
}

// ─── WS Bridge Server (port 3001) ────────────────────────────────────────────
function startBridgeServer() {
  const wss = new WebSocket.Server({ port: WS_PORT });

  wss.on('connection', (ws) => {
    bridgeClients.add(ws);
    // Send full state immediately on connect
    ws.send(JSON.stringify(getFullState()));

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        handleControlMessage(msg, ws);
      } catch (e) { /* ignore */ }
    });

    ws.on('close', () => bridgeClients.delete(ws));
    ws.on('error', () => bridgeClients.delete(ws));
  });

  console.log(`[Bridge] WS server on :${WS_PORT}`);
}

function handleControlMessage(msg, ws) {
  switch (msg.type) {
    case 'set_event_name':
      state.eventName = msg.data.name || '';
      saveAppState();
      broadcastFullState();
      break;

    case 'set_font_family':
      state.fontFamily = msg.data.fontFamily || 'Bourgeois';
      saveAppState();
      broadcastFullState();
      break;

    case 'set_banner_visibility':
      state.banner.visible = !!msg.data.visible;
      saveAppState();
      broadcastFullState();
      break;

    case 'add_banner_image':
      if (msg.data.image) {
        if (!state.banner.images) state.banner.images = [];
        state.banner.images.push(msg.data.image);
        saveAppState();
        broadcastFullState();
      }
      break;

    case 'remove_banner_image':
      if (state.banner.images && typeof msg.data.index === 'number') {
        state.banner.images.splice(msg.data.index, 1);
        saveAppState();
        broadcastFullState();
      }
      break;

    case 'set_banner_interval':
      state.banner.interval = Math.max(1, msg.data.interval || 10);
      saveAppState();
      broadcastFullState();
      break;
    
    case 'set_asset': {
      const { name, image } = msg.data || {};
      if (!ASSET_NAMES.includes(name)) break;   // whitelist guards against path traversal
      try {
        if (!image) {
          delete state.assets[name];
          const f = path.join(assetsDir, name);
          if (fs.existsSync(f)) fs.unlinkSync(f);
        } else {
          const m = /^data:image\/[a-z+.-]+;base64,(.+)$/i.exec(image);
          if (!m) break;
          fs.mkdirSync(assetsDir, { recursive: true });
          fs.writeFileSync(path.join(assetsDir, name), Buffer.from(m[1], 'base64'));
          // ?v= busts the browser cache when the same filename is replaced
          state.assets[name] = `/data/assets/${name}?v=${Date.now()}`;
        }
        saveAppState();
        broadcastFullState();
      } catch (e) { console.error('Error saving asset:', e); }
      break;
    }

    case 'save_preset': {
      // name given = create/overwrite by that name; no name = update the active preset
      const rawName = (msg.data && msg.data.name || '').trim() || state.activePreset;
      if (!rawName) break;
      const slug = slugify(rawName);
      if (!slug) break;
      try {
        const dest = path.join(presetsDir, slug);
        fs.rmSync(dest, { recursive: true, force: true });
        fs.mkdirSync(dest, { recursive: true });

        const assets = {};
        Object.keys(state.assets).forEach(file => {
          const src = path.join(assetsDir, file);
          if (!fs.existsSync(src)) return;
          fs.copyFileSync(src, path.join(dest, file));
          assets[file] = `/data/presets/${slug}/${file}`;
        });

        const idx = savedPresets.findIndex(p => p.slug === slug);
        const entry = { name: rawName, slug, assets };
        if (idx >= 0) savedPresets[idx] = entry;
        else savedPresets.push(entry);

        savePresets();
        state.activePreset = rawName;
        saveAppState();
        broadcastFullState();
      } catch (e) { console.error('Error saving preset:', e); }
      break;
    }

    case 'apply_preset': {
      const p = savedPresets.find(x => x.name === msg.data.name);
      if (!p) break;
      try {
        fs.rmSync(assetsDir, { recursive: true, force: true });
        fs.mkdirSync(assetsDir, { recursive: true });

        const assets = {};
        Object.keys(p.assets || {}).forEach(file => {
          const src = path.join(presetsDir, p.slug, file);
          if (!fs.existsSync(src)) return;
          fs.copyFileSync(src, path.join(assetsDir, file));
          assets[file] = `/data/assets/${file}?v=${Date.now()}`;
        });

        state.assets = assets;
        state.activePreset = p.name;
        saveAppState();
        broadcastFullState();
      } catch (e) { console.error('Error applying preset:', e); }
      break;
    }

    case 'delete_preset': {
      const p = savedPresets.find(x => x.name === msg.data.name);
      if (!p) break;
      try {
        fs.rmSync(path.join(presetsDir, p.slug), { recursive: true, force: true });
      } catch (e) { console.error('Error removing preset folder:', e); }
      savedPresets = savedPresets.filter(x => x.slug !== p.slug);
      savePresets();
      if (state.activePreset === p.name) {
        state.activePreset = null;
        saveAppState();
      }
      broadcastFullState();
      break;
    }

    case 'set_team':
      if (msg.data.side === 'blue' || msg.data.side === 'orange') {
        state.teams[msg.data.side] = {
          name: msg.data.name || '',
          logo: msg.data.logo || null
        };
        saveAppState();
        broadcastFullState();
      }
      break;

    case 'adjust_series':
      if (msg.data.side === 'blue' || msg.data.side === 'orange') {
        state.series[msg.data.side] = Math.max(0, Math.min(Math.ceil(state.bestOf / 2), state.series[msg.data.side] + (msg.data.delta || 0)));
        saveAppState();
        broadcastFullState();
      }
      break;

    case 'set_series':
      if (typeof msg.data.blue === 'number') state.series.blue   = Math.max(0, msg.data.blue);
      if (typeof msg.data.orange === 'number') state.series.orange = Math.max(0, msg.data.orange);
      saveAppState();
      broadcastFullState();
      break;

    case 'set_best_of':
      state.bestOf = msg.data.value || 5;
      state.game.number = Math.min(state.game.number, state.bestOf);
      state.series.blue = Math.min(state.series.blue, Math.ceil(state.bestOf / 2));
      state.series.orange = Math.min(state.series.orange, Math.ceil(state.bestOf / 2));
      saveAppState();
      broadcastFullState();
      break;

    case 'adjust_game_number':
      state.game.number = Math.max(1, Math.min(state.bestOf, state.game.number + (msg.data.delta || 0)));
      saveAppState();
      broadcastFullState();
      break;

    case 'reset_series':
      state.game.number = 1;
      state.series.blue = 0;
      state.series.orange = 0;
      saveAppState();
      broadcastFullState();
      break;

    case 'force_scoreboard':
      state.view = 'scoreboard';
      broadcast(bridgeClients, { type: 'view_change', data: { view: 'scoreboard', playerCache: state.playerCache } });
      break;

    case 'force_hud':
      state.view = 'hud';
      broadcast(bridgeClients, { type: 'view_change', data: { view: 'hud' } });
      break;

    case 'set_facecams_enabled':
      state.facecamsEnabled = !!msg.data.enabled;
      saveAppState();
      broadcastFullState();
      break;

    case 'save_team': {
      const { name, logo, oldName } = msg.data;
      let idx = -1;
      if (oldName) {
        idx = savedTeams.findIndex(t => t.name === oldName);
      }
      if (idx === -1) {
        idx = savedTeams.findIndex(t => t.name === name);
      }

      if (idx >= 0) savedTeams[idx] = { name, logo };
      else savedTeams.push({ name, logo });
      
      saveTeams();
      broadcastFullState();
      break;
    }

    case 'delete_team': {
      savedTeams = savedTeams.filter(t => t.name !== msg.data.name);
      saveTeams();
      broadcastFullState();
      break;
    }

    case 'update_teams_order': {
      savedTeams = msg.data.teams || [];
      saveTeams();
      broadcastFullState();
      break;
    }

    case 'save_facecam': {
      const { name, platform, platformId, link, nickname } = msg.data;
      const idx = savedFacecams.findIndex(fc => fc.name === name);
      const entry = { name, platform, platformId, link, nickname: nickname || name };
      if (idx >= 0) savedFacecams[idx] = entry;
      else savedFacecams.push(entry);
      saveFacecams();
      broadcastFullState();
      break;
    }

    case 'delete_facecam': {
      savedFacecams = savedFacecams.filter(fc => fc.name !== msg.data.name);
      saveFacecams();
      broadcastFullState();
      break;
    }
    
    case 'import_data': {
      (async () => {
        const { path } = msg.data || {};
        if (!path) return;
        try {
          const zipBuffer = await fsp.readFile(path);
          const zip = new AdmZip(zipBuffer);;
          const facecamsEntry  = zip.getEntry("facecams.json");
          const teamsEntry = zip.getEntry("teams.json");

          if (!facecamsEntry || !teamsEntry) {
            sendImportExportResult(ws, false, 'Zip file is missing required files.');
            return;
          }
          const facecams = JSON.parse(facecamsEntry.getData().toString("utf8"));
          const teams = JSON.parse(teamsEntry.getData().toString("utf8"));

          if (Array.isArray(facecams)) {
            savedFacecams = mergeAtTop(
              savedFacecams,
              facecams,
              (a, b) => a.platform === b.platform && a.platformId === b.platformId
            );
            await saveFacecams();
          } else {
            sendImportExportResult(ws, false, 'facecams.json is not valid.');
          }
          if (Array.isArray(teams)) {
            savedTeams = mergeAtTop(
              savedTeams,
              teams,
              (a, b) => a.name === b.name && a.logo === b.logo
            );
            await saveTeams();
          } else {
            sendImportExportResult(ws, false, 'teams.json is not valid.');
          }

          sendImportExportResult(ws, true, 'Data imported successfully.');
          broadcastFullState();
        } catch (err) {
          sendImportExportResult(ws, false, 'Error importing data: ' + err.message);
        }
      })();
      break;
    }

    case 'export_data': {
      const zip = new AdmZip();
      zip.addLocalFile(teamsFile);
      zip.addLocalFile(facecamsFile);

      dialog.showSaveDialog({
        title: 'Export Data',
        defaultPath: 'JotaOverlay-Settings.zip',
        filters: [
          { name: 'Zip Files', extensions: ['zip'] }
        ]
      }).then(({ canceled, filePath }) => {
        if (canceled || !filePath) {
          sendImportExportResult(ws, false, 'Export cancelled.');
          return;
        }

        zip.writeZip(filePath);
        sendImportExportResult(ws, true, 'Data exported successfully.');
      });
      break;
    }

    case 'request_state':
      ws.send(JSON.stringify(getFullState()));
      break;
    
    case 'swap_teams': {
      // Swap names/logos
      const tempTeams = { ...state.teams.blue };
      state.teams.blue = { ...state.teams.orange };
      state.teams.orange = tempTeams;
      
      // Swap series scores
      const tempSeries = state.series.blue;
      state.series.blue = state.series.orange;
      state.series.orange = tempSeries;

      saveAppState();
      broadcastFullState();
      break;
    }

    case 'reset_all': {
      state.eventName = 'ROCKET LEAGUE TOURNAMENT';
      state.fontFamily = 'Bourgeois';
      state.banner = { visible: false, images: [], interval: 10 };
      state.bestOf = 5;
      state.teams = {
        blue:   { name: 'BLUE TEAM',   logo: null },
        orange: { name: 'ORANGE TEAM', logo: null }
      };
      state.series = { blue: 0, orange: 0 };
      state.game = { blueScore: 0, orangeScore: 0, time: 300, isOT: false, number: 1 };
      state.view = 'hud';
      state.playerCache = {};
      state.players = [];
      
      saveAppState();
      broadcastFullState();
      broadcastFullState();
      break;
    }

    case 'set_update_checks_enabled':
      state.updateChecksEnabled = !!msg.data.enabled;
      saveAppState();
      broadcastFullState();
      // If we just enabled it, trigger a check
      if (state.updateChecksEnabled) checkForUpdates();
      break;

    default:
      break;
  }
}

function sendImportExportResult(ws, result, message) {
  ws.send(JSON.stringify({
    type: 'import-export-result',
    data: { result, message }
  }));
}

function mergeAtTop(savedArray, importedArray, isSameItem) {
  const filteredNew = importedArray.filter(importItem => {
    return !savedArray.some(savedItem => isSameItem(savedItem, importItem));
  });

  return [...filteredNew, ...savedArray];
}

function broadcastFullState() {
  broadcast(bridgeClients, getFullState());
}

// ─── HTTP Server (port 3000) — serves overlay ────────────────────────────────
function startHttpServer(baseDir) {
  const app = express();

  // Serve overlay at root
  app.use(express.static(path.join(baseDir, 'overlay')));

  // Serve assets
  app.use('/assets', express.static(path.join(baseDir, 'assets')));

  // Serve team logos from userData data dir
  app.use('/data', express.static(dataDir));

  app.listen(HTTP_PORT, '127.0.0.1', () => {
    console.log(`[HTTP] Overlay at http://localhost:${HTTP_PORT}`);
  });
}

// ─── Start ───────────────────────────────────────────────────────────────────
module.exports.start = function(baseDir) {
  appDir = baseDir || __dirname;

  // Data paths — use userData so teams survive portable exe relocation
  const { app: electronApp } = require('electron');
  const userData = electronApp.getPath('userData');
  dataDir   = path.join(userData, 'data');
  teamsFile = path.join(dataDir, 'teams.json');
  stateFile = path.join(dataDir, 'state.json');
  facecamsFile = path.join(dataDir, 'facecams.json');
  assetsDir = path.join(dataDir, 'assets');
  presetsDir = path.join(dataDir, 'presets');
  presetsFile = path.join(dataDir, 'presets.json');

  fs.mkdirSync(dataDir, { recursive: true });
  loadTeams();
  loadState();
  loadFacecams();
  loadPresets();

  startHttpServer(appDir);
  startBridgeServer();
  connectToRL();
  
  // Check for updates on startup
  setTimeout(checkForUpdates, 3000); 
};
