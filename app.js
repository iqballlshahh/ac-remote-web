import {
  signInWithGoogle, getIdentityId,
  mqttConnect, mqttSubscribe, mqttPublish, mqttDisconnect,
  dynamoQuery, dynamoPut, dynamoUpdate, dynamoDelete,
} from './aws-iot.js';

import { Floorplan } from './floorplan.js';

const DEVICES_TABLE   = 'ac-remote-devices';
const ROOMS_TABLE     = 'ac-remote-rooms';
const SCENES_TABLE    = 'ac-remote-scenes';
const SCHEDULES_TABLE = 'ac-remote-schedules';

const cfg = window.APP_CONFIG;

// ============================================================
// DATA — enums mirror IRremoteESP8266
// ============================================================
const AC_MODES = [
  { v: 1, key: 'auto', label: 'Auto', icon: '🔄' },
  { v: 2, key: 'cool', label: 'Cool', icon: '❄️' },
  { v: 4, key: 'dry',  label: 'Dry',  icon: '💧' },
  { v: 5, key: 'fan',  label: 'Fan',  icon: '🌀' },
  { v: 3, key: 'heat', label: 'Heat', icon: '🔥' },
];
const AC_FANS = [
  { v: 0, label: 'Auto' },
  { v: 2, label: 'Low'  },
  { v: 3, label: 'Med'  },
  { v: 4, label: 'High' },
];
const BRANDS = [
  { v: 16, name: 'Daikin' },             { v: 53, name: 'Daikin 2' },
  { v: 20, name: 'Mitsubishi (AC)' },    { v: 59, name: 'Mitsubishi Heavy 88' },
  { v: 60, name: 'Mitsubishi Heavy 152' },{ v: 49, name: 'Panasonic AC' },
  { v: 24, name: 'Gree' },               { v: 51, name: 'LG (LG2)' },
  { v: 46, name: 'Samsung AC' },         { v: 32, name: 'Toshiba AC' },
  { v: 40, name: 'Hitachi AC' },         { v: 33, name: 'Fujitsu AC' },
  { v: 34, name: 'Midea' },              { v: 18, name: 'Kelvinator' },
  { v: 37, name: 'Carrier AC' },         { v: 45, name: 'Whirlpool AC' },
  { v: 38, name: 'Haier AC' },           { v: 44, name: 'Haier YRW02' },
  { v: 48, name: 'Electra AC' },         { v: 54, name: 'Vestel AC' },
  { v: 55, name: 'Teco' },               { v: 57, name: 'TCL 112' },
  { v: 27, name: 'Argo' },               { v: 15, name: 'Coolix (generic)' },
];
const APPLIANCE_ICONS = { ac: '❄️', fan: '🌀', generic: '🎛️' };

const FAN_BUTTONS = [
  { name: 'power',     label: 'Power',     icon: '⏻' },
  { name: 'speed_up',  label: 'Speed +',   icon: '＋' },
  { name: 'speed_dn',  label: 'Speed −',   icon: '−' },
  { name: 'auto',      label: 'Auto',      icon: '🔄' },
  { name: 'osc_45',    label: '45°',       icon: '↔' },
  { name: 'osc_90',    label: '90°',       icon: '↔↔' },
  { name: 'osc_180',   label: '180°',      icon: '↔↔↔' },
];

// ============================================================
// STATE
// ============================================================
let user           = null;
let userSub        = null;
let rooms          = new Map();
let devices        = new Map();
let scenes         = new Map();   // scene_id -> scene object
let schedules      = new Map();   // schedule_id -> schedule object
let currentRoomId  = null;
let currentDevice  = null;
let currentAppliance = null;
let currentButtons = [];
let homeMode       = 'view';
let floorplan      = null;

// ============================================================
// UTIL
// ============================================================
function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.style.display = 'none');
  document.getElementById(id).style.display = 'block';
}
function setLoading(msg) {
  document.getElementById('loading-msg').textContent = msg || 'loading…';
  show('screen-loading');
}
function toast(msg, ms = 2200) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.display = '';
  clearTimeout(toast._t);
  if (ms === 0 || ms === Infinity) {
    toast._t = null;  // sticky — caller dismisses with hideToast()
  } else {
    toast._t = setTimeout(() => el.style.display = 'none', ms);
  }
}
function hideToast() {
  clearTimeout(toast._t);
  document.getElementById('toast').style.display = 'none';
}
function uid() { return Math.random().toString(36).slice(2, 10); }
function escapeHTML(s) {
  return String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

// ============================================================
// THEME
// ============================================================
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
  if (floorplan) floorplan.setTheme(theme);
}
function initTheme() {
  // Default to light. Only honour dark if the user previously chose it.
  const saved = localStorage.getItem('theme');
  const theme = (saved === 'dark') ? 'dark' : 'light';
  applyTheme(theme);
}
function toggleTheme() {
  const now = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(now);
}
initTheme();

// ============================================================
// LOGIN
// ============================================================
window.addEventListener('load', () => {
  if (!window.google || !cfg.GOOGLE_CLIENT_ID || cfg.GOOGLE_CLIENT_ID.startsWith('REPLACE')) {
    document.querySelector('#screen-login p').textContent =
      'Edit config.js with your Google Client ID before deploying.';
    show('screen-login'); return;
  }
  google.accounts.id.initialize({
    client_id: cfg.GOOGLE_CLIENT_ID,
    callback: onGoogleCredential,
    auto_select: true,
  });
  google.accounts.id.renderButton(document.getElementById('google-btn-wrap'),
    { theme: 'filled_blue', size: 'large', shape: 'pill', text: 'continue_with' });

  const cached = sessionStorage.getItem('google_id_token');
  if (cached) {
    try {
      const claims = JSON.parse(atob(cached.split('.')[1]));
      if (claims.exp * 1000 > Date.now() + 60_000) {
        onGoogleCredential({ credential: cached });
        return;
      }
    } catch {}
    sessionStorage.removeItem('google_id_token');
  }
  show('screen-login');
});

async function onGoogleCredential(resp) {
  setLoading('signing in');
  const idToken = resp.credential;
  const claims = JSON.parse(atob(idToken.split('.')[1]));
  user = { name: claims.name, email: claims.email, picture: claims.picture };

  try {
    const { identityId } = await signInWithGoogle(idToken);
    userSub = identityId;
    sessionStorage.setItem('google_id_token', idToken);
    document.getElementById('user-name').textContent  = user.name;
    document.getElementById('user-email').textContent = user.email;
    document.getElementById('user-avatar').src        = user.picture;

    setLoading('connecting to cloud');
    await mqttConnect();
    setupSubscriptions();

    setLoading('loading rooms');
    await fetchRooms();

    setLoading('loading devices');
    await fetchDevices();

    setLoading('loading scenes & schedules');
    await Promise.all([fetchScenes(), fetchSchedules()]);

    initFloorplan();
    await autoPlaceOrphanRooms();
    // Try to return the user to whatever screen they were on before the refresh
    const restored = restoreNavState();
    if (!restored) {
      show('screen-home');
      renderHome();
    }
  } catch (err) {
    console.error(err);
    toast('sign-in failed: ' + err.message, 4000);
    sessionStorage.removeItem('google_id_token');
    show('screen-login');
  }
}

document.getElementById('logout-btn').onclick = () => {
  mqttDisconnect();
  clearAllUserData();
  userSub = null; user = null;
  sessionStorage.removeItem('google_id_token');
  sessionStorage.removeItem('nav');
  google.accounts.id.disableAutoSelect();
  show('screen-login');
};
document.getElementById('theme-btn').onclick = toggleTheme;

// ============================================================
// DATA
// ============================================================
async function fetchRooms() {
  try {
    const items = await dynamoQuery(ROOMS_TABLE, 'user_id', userSub);
    rooms.clear();
    for (const it of items) rooms.set(it.room_id, it);
  } catch (e) {
    console.error('fetchRooms:', e); toast('could not load rooms', 4000);
  }
}
async function fetchDevices() {
  try {
    const items = await dynamoQuery(DEVICES_TABLE, 'user_id', userSub);
    const seenIds = new Set();
    for (const it of items) {
      seenIds.add(it.device_id);
      const existing = devices.get(it.device_id);
      const dbStamp  = Number(it.updated_at) || 0;
      const memStamp = Number(existing?.lastSeen) || 0;

      // Migration: old-style rows without `appliances` array
      if (!Array.isArray(it.appliances)) {
        it.appliances = [{
          id: 'default', type: 'ac',
          name: it.name || 'AC',
          room_id: it.room_id || '',
          state: {
            protocol:      it.protocol      ?? 16,
            protocol_name: it.protocol_name ?? 'DAIKIN',
            power:         it.power         ?? false,
            mode:          it.mode          ?? 1,
            degrees:       it.degrees       ?? 24,
            fanspeed:      it.fanspeed      ?? 0,
            swingv:        it.swingv        ?? 255,
          },
        }];
      }

      // If MQTT already gave us fresher data than DynamoDB, prefer that — this
      // avoids a race where the retained state message arrives before fetchDevices
      // completes, only for fetchDevices to overwrite it with stale DB data.
      if (existing && memStamp > dbStamp) {
        it.appliances = existing.appliances || it.appliances;
        it.online     = existing.online ?? it.online;
        it.lastSeen   = memStamp;
      } else {
        it.lastSeen = dbStamp;
      }
      devices.set(it.device_id, it);
    }
    // Remove devices that no longer exist server-side
    for (const id of [...devices.keys()]) {
      if (!seenIds.has(id)) devices.delete(id);
    }
  } catch (e) {
    console.error('fetchDevices:', e); toast('could not load devices', 4000);
  }
}

async function fetchScenes() {
  try {
    const items = await dynamoQuery(SCENES_TABLE, 'user_id', userSub);
    scenes.clear();
    for (const it of items) scenes.set(it.scene_id, it);
  } catch (e) {
    console.warn('fetchScenes (table may not exist yet):', e);
  }
}
async function fetchSchedules() {
  try {
    const items = await dynamoQuery(SCHEDULES_TABLE, 'user_id', userSub);
    schedules.clear();
    for (const it of items) schedules.set(it.schedule_id, it);
  } catch (e) {
    console.warn('fetchSchedules (table may not exist yet):', e);
  }
}

// Logout also clears scene/schedule state.
function clearAllUserData() {
  rooms.clear(); devices.clear(); scenes.clear(); schedules.clear();
}

function setupSubscriptions() {
  mqttSubscribe(`ac-remote/users/${userSub}/devices/+/state`, (topic, msg) => {
    const id = topic.split('/')[4];
    const prev = devices.get(id) || {};
    devices.set(id, { ...prev, ...msg, online: !!msg.online, lastSeen: Date.now() });
    rerender();
  });
  mqttSubscribe(`ac-remote/users/${userSub}/devices/+/event`, (topic, msg) => {
    handleEvent(topic.split('/')[4], msg);
  });
}

function rerender() {
  const home   = document.getElementById('screen-home');
  const room   = document.getElementById('screen-room');
  const ctrl   = document.getElementById('screen-control');
  if (home.style.display !== 'none')  renderHome();
  if (room.style.display !== 'none')  renderRoom();
  if (ctrl.style.display !== 'none')  renderControl();
}

function handleEvent(deviceId, ev) {
  if (!ev || !ev.type) return;
  if (ev.type === 'learn_result') {
    const r = ev.payload || {};
    // Clear any in-flight "learning" UI state (sticky toast + pulsing button)
    hideToast();
    document.querySelectorAll('.fan-btn.learning').forEach(el => el.classList.remove('learning'));
    if (r.success) {
      toast(`✓ learned "${r.button}" (${r.edges} edges)`);
      if (currentDevice === deviceId && currentAppliance?.id === r.appliance_id) {
        cmd('list_buttons', { appliance_id: currentAppliance.id });
      }
    } else {
      toast(`learn failed: ${r.error || 'unknown'} — tap again to retry`, 4000);
    }
    const dialog = document.getElementById('learn-dialog');
    if (dialog.open) dialog.close();
  } else if (ev.type === 'button_list') {
    const p = ev.payload || {};
    if (currentDevice === deviceId && currentAppliance?.id === p.appliance_id) {
      currentButtons = p.buttons || [];
      renderControl();
    }
  } else if (ev.type === 'delete_result') {
    cmd('list_buttons', { appliance_id: currentAppliance.id });
  }
}

// One-tap learn: name is already known (it's the button label), so skip the
// dialog and immediately tell the device to start listening. We add a pulsing
// visual to the tapped tile + a sticky toast telling the user what to do.
function startQuickLearn(buttonName) {
  if (!currentAppliance || !currentDevice) return;
  if (!isDeviceLive(devices.get(currentDevice))) {
    toast('device is offline — bring it online first', 3500);
    return;
  }
  cmd('learn', { appliance_id: currentAppliance.id, button: buttonName });
  // Long-lived toast that stays until learn_result arrives
  toast(`🎯 Learning "${buttonName}" — aim your real remote at the device and press the button (12s)…`, 0);
  // Pulse the tile being learned
  document.querySelectorAll(`[data-fan-btn="${buttonName}"]`).forEach(el => el.classList.add('learning'));
}

function cmd(type, payload = {}) {
  if (!currentDevice) {
    console.warn('[cmd] no currentDevice set, dropping', type, payload);
    return;
  }
  sendCommand(currentDevice, type, payload);
}

// Lower-level command sender for scenes/schedules — doesn't depend on currentDevice.
function sendCommand(deviceId, type, payload = {}) {
  if (!deviceId) {
    console.warn('[sendCommand] no deviceId', type, payload);
    return false;
  }
  const d = devices.get(deviceId);
  const passThrough = new Set(['factory_reset', 'delete_appliance']);
  if (!passThrough.has(type) && !isDeviceLive(d)) {
    console.warn('[sendCommand] device offline, dropping', { deviceId, type, payload, lastSeen: d?.lastSeen, online: d?.online });
    return false;
  }
  const topic = `ac-remote/users/${userSub}/devices/${deviceId}/cmd`;
  console.log('[sendCommand]', deviceId, type, payload);
  mqttPublish(topic, { type, payload });
  return true;
}

// A device is "live" if it reported online recently. The DynamoDB online flag
// can be stale if the device crashed without a clean disconnect, so we also
// require its last heartbeat (updated_at / lastSeen) to be within the threshold.
// 180s = 3 minutes = three missed 60s heartbeats. Tighter than this and we get
// false-offline reports when the network has a brief hiccup.
const LIVE_THRESHOLD_MS = 180_000;
function isDeviceLive(device) {
  if (!device || !device.online) return false;
  const t = Number(device.lastSeen || device.updated_at || 0);
  if (!t) return device.online;
  return (Date.now() - t) < LIVE_THRESHOLD_MS;
}

// =================== navigation state persistence ===================
// Remembering which screen the user was on so a page refresh keeps them there.
function saveNavState() {
  const home = document.getElementById('screen-home').style.display !== 'none';
  const room = document.getElementById('screen-room').style.display !== 'none';
  const ctrl = document.getElementById('screen-control').style.display !== 'none';
  let state = null;
  if (ctrl && currentDevice && currentAppliance) {
    state = { screen: 'control', deviceId: currentDevice, applianceId: currentAppliance.id, roomId: currentRoomId };
  } else if (room && currentRoomId) {
    state = { screen: 'room', roomId: currentRoomId };
  } else if (home) {
    state = { screen: 'home' };
  }
  if (state) sessionStorage.setItem('nav', JSON.stringify(state));
}
function restoreNavState() {
  let s = null;
  try { s = JSON.parse(sessionStorage.getItem('nav') || 'null'); } catch {}
  if (!s) return false;
  if (s.screen === 'control' && s.deviceId && s.applianceId) {
    const d = devices.get(s.deviceId);
    const ap = d && (d.appliances || []).find(a => a.id === s.applianceId);
    if (d && ap) {
      if (s.roomId && rooms.has(s.roomId)) currentRoomId = s.roomId;
      openControl(s.deviceId, s.applianceId);
      return true;
    }
  } else if (s.screen === 'room' && s.roomId && rooms.has(s.roomId)) {
    openRoom(s.roomId);
    return true;
  }
  return false;
}

// Periodically re-render so offline status updates as the heartbeat ages out.
setInterval(() => {
  const home = document.getElementById('screen-home');
  const room = document.getElementById('screen-room');
  const ctrl = document.getElementById('screen-control');
  if (home.style.display !== 'none' || room.style.display !== 'none' || ctrl.style.display !== 'none') {
    rerender();
  }
}, 15_000);

// ============================================================
// FLOORPLAN BOOTSTRAP + HOME RENDERING
// ============================================================
function initFloorplan() {
  if (floorplan) return;
  floorplan = new Floorplan({
    container3D: document.getElementById('floorplan-3d'),
    container2D: document.getElementById('floorplan-2d'),
    canvas3D:    document.getElementById('floorplan-3d-canvas'),
    svg2D:       document.getElementById('floorplan-2d-svg'),
    tooltip3D:   ensureTooltip3D(),
    getRooms:    () => rooms,
    getDeviceCountForRoom: countAppliancesInRoom,
    isRoomActive: (rid) => {
      for (const d of devices.values())
        for (const a of (d.appliances || []))
          if ((a.room_id || d.room_id) === rid && a.state?.power) return true;
      return false;
    },
    getAppliancesForRoom: (rid) => {
      const out = [];
      for (const d of devices.values()) {
        for (const a of (d.appliances || [])) {
          if ((a.room_id || d.room_id) === rid) {
            out.push({ ...a, deviceId: d.device_id });
          }
        }
      }
      return out;
    },
    onRoomTap:       (rid) => openRoom(rid),
    onApplianceTap:  (deviceId, applianceId) => openControl(deviceId, applianceId),
    onRoomEdit:      (rid) => openRoomDialog(rid),
    onLayoutChange:  () => persistDirtyLayouts(),
  });
  floorplan.setTheme(document.documentElement.getAttribute('data-theme'));
}

function ensureTooltip3D() {
  let t = document.querySelector('.fp-room-tooltip');
  if (t) return t;
  t = document.createElement('div');
  t.className = 'fp-room-tooltip';
  t.style.opacity = '0';
  document.getElementById('floorplan-3d').appendChild(t);
  return t;
}

// Rooms created before the floor-plan feature have no `floor_plan` attribute.
// Auto-place them so they appear in 3D immediately, then persist.
async function autoPlaceOrphanRooms() {
  if (!floorplan) return;
  for (const r of rooms.values()) {
    if (!r.floor_plan) {
      r.floor_plan = floorplan.autoPlace();
      try {
        await dynamoPut(ROOMS_TABLE, {
          user_id: userSub, room_id: r.room_id,
          name: r.name, icon: r.icon,
          floor_plan: r.floor_plan,
        });
      } catch (err) {
        console.error('auto-place failed for', r.room_id, err);
      }
    }
  }
  floorplan.refresh();
}

function countAppliancesInRoom(roomId) {
  let n = 0;
  for (const d of devices.values())
    for (const a of (d.appliances || []))
      if ((a.room_id || d.room_id) === roomId) n++;
  return n;
}

// Persist any layout edits (drag/resize) to DynamoDB
async function persistDirtyLayouts() {
  const dirty = floorplan.getDirtyRooms();
  for (const { roomId, floor_plan } of dirty) {
    const r = rooms.get(roomId);
    if (!r) continue;
    r.floor_plan = floor_plan;
    try {
      await dynamoPut(ROOMS_TABLE, {
        user_id: userSub, room_id: roomId,
        name: r.name, icon: r.icon,
        floor_plan,
      });
    } catch (err) {
      console.error('persist room failed', err);
    }
  }
  floorplan.clearDirty();
}

function renderHome() {
  // Render unassigned appliances list
  const unassigned = document.getElementById('unassigned-list');
  unassigned.innerHTML = '';
  let orphans = [];
  for (const d of devices.values())
    for (const a of (d.appliances || [])) {
      const rid = a.room_id || d.room_id || '';
      if (!rid || !rooms.has(rid)) orphans.push({ device: d, appliance: a });
    }
  const hasDevices = devices.size > 0;
  if (orphans.length === 0) {
    unassigned.innerHTML = hasDevices
      ? `<p class="dim small">All appliances are assigned to rooms. Tap a room above to control them.</p>`
      : `<p class="dim small">No appliances yet. Tap <strong>+ add device</strong> to pair your first one.</p>`;
  } else {
    for (const { device, appliance } of orphans) unassigned.appendChild(applianceTile(device, appliance));
  }

  renderScenes();
  renderSchedules();

  if (floorplan) {
    floorplan.setMode(homeMode);
  }
}

function renderScenes() {
  const grid = document.getElementById('scenes-grid');
  if (!grid) return;
  grid.innerHTML = '';
  const list = [...scenes.values()].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  if (list.length === 0) {
    const intro = document.createElement('div');
    intro.className = 'scenes-empty';
    intro.innerHTML = `
      <p class="dim small">
        <strong>Scenes</strong> are one-tap shortcuts that fire multiple commands at once. Example:
        a <em>"Movie Time"</em> scene that turns the Living Room AC down to 22°C in Cool mode
        <em>and</em> presses the "off" button on the fan — all from one tap.
        Useful if you find yourself doing the same combination of things often.
      </p>
    `;
    grid.appendChild(intro);
  }
  for (const s of list) {
    const card = document.createElement('div');
    card.className = 'scene-card';
    const n = (s.actions || []).length;
    card.innerHTML = `
      <div class="scene-icon">${s.icon || '✨'}</div>
      <div class="scene-name">${escapeHTML(s.name)}</div>
      <div class="scene-count">${n} action${n === 1 ? '' : 's'}</div>
      <button class="scene-edit" data-edit="${s.scene_id}">edit</button>
    `;
    card.onclick = (e) => {
      if (e.target.dataset?.edit) return;
      fireScene(s.scene_id);
    };
    card.querySelector('.scene-edit').onclick = (e) => {
      e.stopPropagation();
      openSceneDialog(s.scene_id);
    };
    grid.appendChild(card);
  }
  const add = document.createElement('div');
  add.className = 'add-scene-card';
  add.textContent = '+ new scene';
  add.onclick = () => openSceneDialog(null);
  grid.appendChild(add);
}

function renderSchedules() {
  const list = document.getElementById('schedules-list');
  if (!list) return;
  list.innerHTML = '';
  const sched = [...schedules.values()].sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  if (sched.length === 0) {
    list.innerHTML = `
      <p class="dim small">
        No schedules yet. Schedules fire automatically at a chosen time, even when your phone is off.
        <br><br>
        <strong>Best way to add one:</strong> open an appliance → ⚙ settings → "+ add" under Schedules.
        That's much easier because the appliance is already known.
      </p>`;
    return;
  }
  const dayLetters = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  for (const s of sched) {
    const card = document.createElement('div');
    card.className = 'schedule-card' + (s.enabled === false ? ' disabled' : '');
    const days = (s.days || []).map(d => dayLetters[d]).join(' · ');
    // Find which appliance this schedule targets (from its first action)
    const a0 = s.actions?.[0];
    const dev = devices.get(a0?.device_id);
    const ap  = dev?.appliances?.find(x => x.id === a0?.payload?.appliance_id);
    const targetLabel = ap ? `${APPLIANCE_ICONS[ap.type] || ''} ${ap.name}` : '';
    card.innerHTML = `
      <div class="sc-time">${escapeHTML(s.time || '--:--')}</div>
      <div class="sc-meta">
        <div class="sc-name">${escapeHTML(s.name || 'Unnamed')}</div>
        <div class="sc-days">${escapeHTML([targetLabel, days].filter(Boolean).join(' · '))}</div>
      </div>
      <div class="sc-toggle ${s.enabled === false ? '' : 'on'}" data-toggle="${s.schedule_id}"></div>
    `;
    card.onclick = (e) => {
      if (e.target.dataset?.toggle) {
        toggleSchedule(s.schedule_id);
        return;
      }
      // Prefer per-appliance editor if this schedule targets a known appliance
      if (ap && dev) {
        openApplianceScheduleDialog(dev.device_id, ap.id, s.schedule_id);
      } else {
        openScheduleDialog(s.schedule_id);
      }
    };
    list.appendChild(card);
  }
}

async function toggleSchedule(scheduleId) {
  const s = schedules.get(scheduleId);
  if (!s) return;
  s.enabled = s.enabled === false ? true : false;
  try {
    await dynamoPut(SCHEDULES_TABLE, s);
    renderSchedules();
  } catch (err) {
    toast('toggle failed: ' + err.message, 4000);
  }
}

// Fire a scene — execute all its actions sequentially with small delays.
async function fireScene(sceneId) {
  const s = scenes.get(sceneId);
  if (!s) return;
  let firedCount = 0, skipped = 0;
  for (const action of (s.actions || [])) {
    const ok = sendCommand(action.device_id, action.type, action.payload);
    if (ok) firedCount++; else skipped++;
    await new Promise(r => setTimeout(r, 250));  // small delay between commands
  }
  if (skipped) toast(`scene "${s.name}" fired (${firedCount} sent, ${skipped} skipped — offline)`, 3500);
  else         toast(`scene "${s.name}" fired (${firedCount} action${firedCount === 1 ? '' : 's'})`);
}

// Home mode toggle (3D / 2D)
document.querySelectorAll('.home-mode-toggle button').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.home-mode-toggle button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    homeMode = btn.dataset.homeMode;
    if (floorplan) floorplan.setMode(homeMode);
  };
});

// 2D-editor toolbar
document.getElementById('add-room-2d').onclick = async () => {
  // Quick-create: ask name in a dialog, then drop on floor plan
  editingRoomId = null;
  document.getElementById('room-dialog-title').textContent = 'Add a room';
  document.getElementById('room-delete').style.display = 'none';
  document.getElementById('room-name-input').value = '';
  document.querySelectorAll('#room-icon-picker button').forEach((b, i) => {
    b.classList.toggle('selected', b.dataset.icon === '🚪');
    b.onclick = (e) => {
      e.preventDefault();
      document.querySelectorAll('#room-icon-picker button').forEach(x => x.classList.remove('selected'));
      b.classList.add('selected');
    };
  });
  document.getElementById('room-dialog').showModal();
};
document.getElementById('edit-selected-room').onclick = () => {
  if (!floorplan.getSelectedRoomId()) return;
  openRoomDialog(floorplan.getSelectedRoomId());
};
document.getElementById('delete-selected-room').onclick = async () => {
  const rid = floorplan.getSelectedRoomId();
  if (!rid) return;
  if (!confirm('Delete this room? Appliances in it will become unassigned.')) return;
  try {
    await dynamoDelete(ROOMS_TABLE, 'user_id', userSub, 'room_id', rid);
    rooms.delete(rid);
    floorplan.clearSelection();
    floorplan.refresh();
    renderHome();
  } catch (err) {
    toast('delete failed: ' + err.message, 4000);
  }
};

// ============================================================
// ROOM DIALOG (add / edit)
// ============================================================
// Auto-suggest room name from icon
const ICON_TO_NAME = {
  '🛋️': 'Living Room',
  '🛏️': 'Bedroom',
  '🍳': 'Kitchen',
  '🛁': 'Bathroom',
  '🚪': 'Hallway',
  '💼': 'Office',
  '🎮': 'Game Room',
  '📚': 'Study',
  '🪴': 'Balcony',
};
let editingRoomId = null;
function openRoomDialog(roomId) {
  editingRoomId = roomId;
  const isEdit = !!roomId;
  document.getElementById('room-dialog-title').textContent = isEdit ? 'Edit room' : 'Add a room';
  document.getElementById('room-delete').style.display = isEdit ? '' : 'none';
  const r = isEdit ? rooms.get(roomId) : { name: '', icon: '🚪' };
  const nameInput = document.getElementById('room-name-input');
  nameInput.value = r.name || '';
  // Whether the name input has been manually edited this session
  let userEdited = !!r.name;
  nameInput.oninput = () => { userEdited = true; };

  document.querySelectorAll('#room-icon-picker button').forEach(b => {
    b.classList.toggle('selected', b.dataset.icon === (r.icon || '🚪'));
    b.onclick = (e) => {
      e.preventDefault();
      document.querySelectorAll('#room-icon-picker button').forEach(x => x.classList.remove('selected'));
      b.classList.add('selected');
      // Auto-fill name from the icon if the user hasn't typed their own yet
      if (!userEdited) {
        const suggested = ICON_TO_NAME[b.dataset.icon];
        if (suggested) nameInput.value = suggested;
      }
    };
  });
  document.getElementById('room-dialog').showModal();
}
document.getElementById('room-cancel').onclick = (e) => { e.preventDefault(); document.getElementById('room-dialog').close(); };
document.getElementById('room-save').onclick = async (e) => {
  e.preventDefault();
  const name = document.getElementById('room-name-input').value.trim();
  const icon = document.querySelector('#room-icon-picker button.selected')?.dataset.icon || '🚪';
  if (!name) { toast('name the room'); return; }
  const roomId = editingRoomId || uid();
  const existing = rooms.get(roomId);
  // Preserve floor_plan if editing, auto-place if new
  let floor_plan = existing?.floor_plan;
  if (!floor_plan) floor_plan = floorplan ? floorplan.autoPlace() : { x: 0, y: 0, width: 4, height: 3 };
  const item = { user_id: userSub, room_id: roomId, name, icon, floor_plan };
  try {
    await dynamoPut(ROOMS_TABLE, item);
    rooms.set(roomId, item);
    document.getElementById('room-dialog').close();
    if (currentRoomId === roomId) {
      document.getElementById('room-name').textContent = `${icon} ${name}`;
    }
    if (floorplan) floorplan.refresh();
    renderHome();
  } catch (err) {
    toast('save failed: ' + err.message, 4000);
  }
};
document.getElementById('room-delete').onclick = async (e) => {
  e.preventDefault();
  if (!editingRoomId) return;
  if (!confirm('Delete this room? Appliances in it will become unassigned.')) return;
  try {
    await dynamoDelete(ROOMS_TABLE, 'user_id', userSub, 'room_id', editingRoomId);
    rooms.delete(editingRoomId);
    document.getElementById('room-dialog').close();
    if (currentRoomId === editingRoomId) { currentRoomId = null; show('screen-home'); }
    if (floorplan) { floorplan.clearSelection(); floorplan.refresh(); }
    renderHome();
  } catch (err) {
    toast('delete failed: ' + err.message, 4000);
  }
};

// ============================================================
// ROOM SCREEN
// ============================================================
function openRoom(roomId) {
  currentRoomId = roomId;
  const r = rooms.get(roomId);
  document.getElementById('room-name').textContent = `${r.icon || '🚪'} ${r.name}`;
  show('screen-room');
  renderRoom();
  saveNavState();
}
function renderRoom() {
  if (!currentRoomId) return;
  const container = document.getElementById('room-appliances');
  const empty     = document.getElementById('room-empty');
  container.innerHTML = '';
  let count = 0;
  for (const d of devices.values())
    for (const a of (d.appliances || []))
      if ((a.room_id || d.room_id) === currentRoomId) {
        container.appendChild(applianceTile(d, a));
        count++;
      }
  empty.style.display = count === 0 ? '' : 'none';
}
document.getElementById('room-back-btn').onclick = () => { currentRoomId = null; show('screen-home'); renderHome(); saveNavState(); };
document.getElementById('room-edit-btn').onclick = () => openRoomDialog(currentRoomId);

function applianceTile(device, appliance) {
  const el = document.createElement('div');
  el.className = 'appliance-tile';
  const state = appliance.state || {};
  const isOn = state.power === true;
  const live = isDeviceLive(device);
  if (isOn && live) el.classList.add('power-on');
  if (!live) el.classList.add('offline');
  let summary;
  if (!live) {
    summary = 'offline';
  } else if (appliance.type === 'ac') {
    summary = isOn
      ? `${(AC_MODES.find(m => m.v === state.mode) || {}).label || ''} · ${state.degrees || '?'}°`
      : 'standby';
  } else if (appliance.type === 'fan') {
    summary = 'fan';
  } else {
    summary = 'remote';
  }
  el.innerHTML = `
    <div class="ap-icon">${APPLIANCE_ICONS[appliance.type] || '🎛️'}</div>
    <div class="ap-meta">
      <div class="ap-name">${escapeHTML(appliance.name)}</div>
      <div class="ap-state">${escapeHTML(summary)}</div>
    </div>
    <div class="ap-online ${live ? 'on' : ''}" title="${live ? 'online' : 'offline'}"></div>
  `;
  el.onclick = () => openControl(device.device_id, appliance.id);
  return el;
}

// ============================================================
// CONTROL SCREEN
// ============================================================
function openControl(deviceId, applianceId) {
  currentDevice = deviceId;
  const d = devices.get(deviceId);
  currentAppliance = (d.appliances || []).find(a => a.id === applianceId);
  if (!currentAppliance) return;
  document.getElementById('control-title').textContent = currentAppliance.name;
  show('screen-control');
  renderControl();
  if (currentAppliance.type !== 'ac') cmd('list_buttons', { appliance_id: currentAppliance.id });
  saveNavState();
}
document.getElementById('control-back-btn').onclick = () => {
  currentDevice = null; currentAppliance = null; currentButtons = [];
  if (currentRoomId) { show('screen-room'); renderRoom(); }
  else               { show('screen-home'); renderHome(); }
  saveNavState();
};
document.getElementById('control-settings-btn').onclick = () => openSettings();

function renderControl() {
  if (!currentAppliance) return;
  const d = devices.get(currentDevice);
  currentAppliance = (d.appliances || []).find(a => a.id === currentAppliance.id) || currentAppliance;
  const body = document.getElementById('control-body');
  body.innerHTML = '';

  // Offline banner — sits above the control widget regardless of appliance type
  if (!isDeviceLive(d)) {
    const banner = document.createElement('div');
    banner.className = 'offline-banner';
    banner.innerHTML = `
      <span class="offline-dot"></span>
      <div>
        <strong>Device is offline.</strong>
        <span class="dim small">Check that it's powered on and connected to WiFi. Commands won't be sent until it's back.</span>
      </div>
    `;
    body.appendChild(banner);
  }

  if (currentAppliance.type === 'ac')      renderAcControl(body);
  else if (currentAppliance.type === 'fan') renderFanControl(body);
  else                                       renderGenericControl(body);
}

// ---- AC remote ----
function renderAcControl(root) {
  const st = currentAppliance.state || {};
  const power = !!st.power;
  const temp = Math.round(st.degrees ?? 24);
  const modeV = st.mode ?? 1;
  const fan = st.fanspeed ?? 0;
  const modeObj = AC_MODES.find(m => m.v === modeV) || AC_MODES[0];

  // Ring math — temp 16..30 maps to a 270° arc
  const minT = 16, maxT = 30;
  const pct = Math.max(0, Math.min(1, (temp - minT) / (maxT - minT)));
  const circ = 2 * Math.PI * 90;
  const arcMax = 0.75 * circ;        // 270 deg in stroke length
  const dashFill = pct * arcMax;
  const dashEmpty = circ - dashFill;

  root.innerHTML = `
    <div class="ac-stage">
      <div class="ac-hero ${power ? `on ${modeObj.key}` : ''}">
        <div class="ac-mode-label">${escapeHTML(modeObj.label)} mode</div>
        <div class="ac-status">${power ? 'cooling' : 'standby'}</div>
        <div class="ac-temp-ring">
          <svg viewBox="0 0 220 220">
            <circle class="ring-bg" cx="110" cy="110" r="90"
                    stroke-dasharray="${arcMax} ${circ - arcMax}"
                    stroke-dashoffset="${circ * 0.125}"></circle>
            <circle class="ring-fg" cx="110" cy="110" r="90"
                    stroke-dasharray="${dashFill} ${circ}"
                    stroke-dashoffset="${circ * 0.125}"></circle>
          </svg>
          <div class="ring-readout">
            <div class="ring-temp">${temp}<sup>°C</sup></div>
            <div class="ring-mode">${modeObj.icon} ${escapeHTML(modeObj.label)}</div>
          </div>
        </div>
        <div class="ac-temp-arrows">
          <button id="t-dn" aria-label="cooler">−</button>
          <button id="t-up" aria-label="warmer">＋</button>
        </div>
        <button class="ac-power-btn" id="ac-power">${power ? 'turn off' : 'turn on'}</button>
      </div>
      <div class="ac-controls">
        <div class="ac-row">
          <div class="row-label">Mode</div>
          <div class="pill-group">
            ${AC_MODES.map(m => `
              <button data-mode-key="${m.key}" data-mode="${m.v}" class="${m.v===modeV?'active':''}">${m.icon} ${m.label}</button>
            `).join('')}
          </div>
        </div>
        <div class="ac-row">
          <div class="row-label">Fan speed</div>
          <div class="pill-group">
            ${AC_FANS.map(f => `<button data-fan="${f.v}" class="${f.v===fan?'active':''}">${f.label}</button>`).join('')}
          </div>
        </div>
      </div>
    </div>
  `;
  document.getElementById('ac-power').onclick = () => setAc({ power: !power });
  document.getElementById('t-up').onclick     = () => setAc({ degrees: Math.min(30, temp + 1) });
  document.getElementById('t-dn').onclick     = () => setAc({ degrees: Math.max(16, temp - 1) });
  root.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => setAc({ mode: Number(b.dataset.mode) }));
  root.querySelectorAll('[data-fan]').forEach(b  => b.onclick = () => setAc({ fanspeed: Number(b.dataset.fan) }));
}
function setAc(changes) {
  Object.assign(currentAppliance.state, changes);
  cmd('set_ac', {
    appliance_id: currentAppliance.id,
    protocol: currentAppliance.state.protocol,
    power:    currentAppliance.state.power,
    mode:     currentAppliance.state.mode,
    degrees:  currentAppliance.state.degrees,
    fanspeed: currentAppliance.state.fanspeed,
    swingv:   currentAppliance.state.swingv,
    ...changes,
  });
  renderControl();
}

// ---- Fan remote ----
function renderFanControl(root) {
  const learned = new Set(currentButtons);
  const isPowerOn = false;
  const mainButtons = FAN_BUTTONS.slice(0, 4);
  const oscButtons  = FAN_BUTTONS.slice(4);
  // Any learned buttons that don't match a predefined fan button name — show them as extras
  const predefinedNames = new Set(FAN_BUTTONS.map(b => b.name));
  const customLearned = currentButtons.filter(n => !predefinedNames.has(n));

  root.innerHTML = `
    <div class="fan-stage">
      <div class="fan-hero ${isPowerOn ? 'on' : ''}">
        <div class="ac-mode-label">${escapeHTML(currentAppliance.name)}</div>
        <div class="fan-rotor">🌀</div>
        <p class="dim small">Tap a button to send. Tap a locked one to teach it.</p>
      </div>
      <div class="fan-buttons">
        ${mainButtons.map(b => `
          <div class="fan-btn ${learned.has(b.name) ? '' : 'locked'}" data-fan-btn="${b.name}">
            <div class="fb-icon">${b.icon}</div>
            <div class="fb-label">${b.label}</div>
          </div>
        `).join('')}
      </div>
      <div class="ac-row" style="margin-top:14px">
        <div class="row-label">Oscillation</div>
        <div class="fan-osc">
          ${oscButtons.map(b => `
            <div class="fan-btn ${learned.has(b.name) ? '' : 'locked'}" data-fan-btn="${b.name}">
              <div class="fb-icon">${b.icon}</div>
              <div class="fb-label">${b.label}</div>
            </div>
          `).join('')}
        </div>
      </div>
      ${customLearned.length > 0 ? `
        <div class="ac-row" style="margin-top:14px">
          <div class="row-label">Custom buttons</div>
          <div class="generic-grid" style="margin-top:0">
            ${customLearned.map(n => `
              <div class="generic-btn" data-custom-btn="${escapeHTML(n)}">
                <div class="gb-icon">🔘</div>
                <div class="gb-label">${escapeHTML(n)}</div>
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}
      <div class="generic-grid" style="margin-top:14px">
        <div class="add-button-tile" id="fan-learn-btn">+ learn a custom button</div>
      </div>
    </div>
  `;
  // Predefined buttons: if learned, send; if not, immediately start learning
  // (name is already known — no need for a dialog).
  root.querySelectorAll('[data-fan-btn]').forEach(el => {
    el.onclick = () => {
      const name = el.dataset.fanBtn;
      if (!learned.has(name)) {
        startQuickLearn(name);
        return;
      }
      cmd('send_raw', { appliance_id: currentAppliance.id, button: name });
    };
  });
  // Custom buttons: send on click, right-click to delete
  root.querySelectorAll('[data-custom-btn]').forEach(el => {
    el.onclick = () => cmd('send_raw', { appliance_id: currentAppliance.id, button: el.dataset.customBtn });
    el.oncontextmenu = (e) => {
      e.preventDefault();
      if (confirm(`delete button "${el.dataset.customBtn}"?`))
        cmd('delete_button', { appliance_id: currentAppliance.id, button: el.dataset.customBtn });
    };
  });
  document.getElementById('fan-learn-btn').onclick = () => openLearnDialog();
}

// ---- Generic remote ----
function renderGenericControl(root) {
  if (currentButtons.length === 0) {
    root.innerHTML = `
      <p class="dim center" style="padding:30px 20px">No buttons learned yet.<br>Tap below to teach this remote its first button.</p>
      <div class="generic-grid">
        <div class="add-button-tile" id="gen-learn-btn">+ learn a button</div>
      </div>
    `;
    document.getElementById('gen-learn-btn').onclick = () => openLearnDialog();
    return;
  }
  const tiles = currentButtons.map(n => `
    <div class="generic-btn" data-gen-btn="${escapeHTML(n)}">
      <div class="gb-icon">🔘</div>
      <div class="gb-label">${escapeHTML(n)}</div>
    </div>
  `).join('');
  root.innerHTML = `
    <p class="dim small" style="margin-bottom:8px">Tap to send. Right-click to delete.</p>
    <div class="generic-grid">
      ${tiles}
      <div class="add-button-tile" id="gen-learn-btn">+ learn a button</div>
    </div>
  `;
  root.querySelectorAll('[data-gen-btn]').forEach(el => {
    el.onclick = () => cmd('send_raw', { appliance_id: currentAppliance.id, button: el.dataset.genBtn });
    el.oncontextmenu = (e) => {
      e.preventDefault();
      if (confirm(`delete button "${el.dataset.genBtn}"?`))
        cmd('delete_button', { appliance_id: currentAppliance.id, button: el.dataset.genBtn });
    };
  });
  document.getElementById('gen-learn-btn').onclick = () => openLearnDialog();
}

// ============================================================
// LEARN DIALOG
// ============================================================
function openLearnDialog(prefillName) {
  document.getElementById('learn-name').value = prefillName || '';
  document.getElementById('learn-status').style.display = 'none';
  document.getElementById('learn-dialog').showModal();
}
document.getElementById('learn-cancel').onclick = (e) => { e.preventDefault(); document.getElementById('learn-dialog').close(); };
document.getElementById('learn-start').onclick  = (e) => {
  e.preventDefault();
  const name = document.getElementById('learn-name').value.trim();
  if (!name) { toast('name the button first'); return; }
  cmd('learn', { appliance_id: currentAppliance.id, button: name });
  const s = document.getElementById('learn-status');
  s.style.display = '';
  s.textContent = 'waiting for IR signal — aim your remote at the receiver and press the button within 12s…';
};

// ============================================================
// ADD DEVICE — Web Bluetooth
// ============================================================
const BLE_SERVICE_UUID     = '7c30b8e2-cabb-4a2e-8d05-e44bd6a3a8e1';
const BLE_CHAR_CONFIG_UUID = '7c30b8e2-cabb-4a2e-8d05-e44bd6a3a8e2';
const BLE_CHAR_STATUS_UUID = '7c30b8e2-cabb-4a2e-8d05-e44bd6a3a8e3';

document.getElementById('add-device-btn').onclick = () => {
  document.getElementById('pair-name').value = '';
  document.getElementById('pair-ssid').value = '';
  document.getElementById('pair-pass').value = '';
  document.getElementById('add-progress').style.display = 'none';
  const sel = document.getElementById('pair-room');
  sel.innerHTML = '<option value="">(unassigned)</option>';
  for (const r of rooms.values()) {
    const opt = document.createElement('option');
    opt.value = r.room_id; opt.textContent = `${r.icon || '🚪'} ${r.name}`;
    sel.appendChild(opt);
  }
  // Reset to a single default AC appliance and render the list builder
  pairingAppliances = [{ id: uid(), type: 'ac', name: 'AC' }];
  renderPairingAppliances();
  document.getElementById('add-dialog').showModal();
};

// State for the multi-appliance list inside the pair dialog
let pairingAppliances = [];

function renderPairingAppliances() {
  const host = document.getElementById('pair-appliances-list');
  if (!host) return;
  host.innerHTML = '';
  pairingAppliances.forEach((ap, idx) => {
    const row = document.createElement('div');
    row.className = 'pair-app-row';
    row.innerHTML = `
      <select class="pap-type">
        <option value="ac"${ap.type==='ac'?' selected':''}>Air conditioner</option>
        <option value="fan"${ap.type==='fan'?' selected':''}>Fan</option>
        <option value="generic"${ap.type==='generic'?' selected':''}>Other</option>
      </select>
      <input class="pap-name" type="text" placeholder="name" maxlength="32" value="${escapeHTML(ap.name)}">
      <button class="pap-remove" title="remove">✕</button>
    `;
    row.querySelector('.pap-type').onchange = (e) => { pairingAppliances[idx].type = e.target.value; };
    row.querySelector('.pap-name').oninput  = (e) => { pairingAppliances[idx].name = e.target.value; };
    row.querySelector('.pap-remove').onclick = (e) => {
      e.preventDefault();
      if (pairingAppliances.length <= 1) {
        toast('a device needs at least one appliance'); return;
      }
      pairingAppliances.splice(idx, 1);
      renderPairingAppliances();
    };
    host.appendChild(row);
  });
}

document.getElementById('pair-add-appliance').onclick = (e) => {
  e.preventDefault();
  // Sensible defaults for the second-and-beyond appliances
  const next = pairingAppliances.length === 0
    ? { id: uid(), type: 'ac', name: 'AC' }
    : { id: uid(), type: 'fan', name: '' };
  pairingAppliances.push(next);
  renderPairingAppliances();
};

document.getElementById('add-cancel').onclick = (e) => { e.preventDefault(); document.getElementById('add-dialog').close(); };
document.getElementById('add-submit').onclick = async (e) => {
  e.preventDefault();
  const name = document.getElementById('pair-name').value.trim();
  const ssid = document.getElementById('pair-ssid').value.trim();
  const pass = document.getElementById('pair-pass').value;
  const roomId = document.getElementById('pair-room').value || '';

  if (!name || !ssid) { toast('fill in device name and WiFi SSID'); return; }
  if (pairingAppliances.length === 0) { toast('add at least one appliance'); return; }
  // Auto-fill any blank appliance names so the firmware doesn't end up with "Appliance" entries everywhere
  pairingAppliances.forEach(a => {
    if (!a.name || !a.name.trim()) {
      a.name = ({ ac: 'AC', fan: 'Fan', generic: 'Remote' })[a.type] || 'Appliance';
    }
  });
  if (!navigator.bluetooth) { toast('Web Bluetooth not supported in this browser', 4000); return; }

  const progress = document.getElementById('add-progress');
  const progressMsg = document.getElementById('add-progress-msg');
  progress.style.display = 'block';
  progressMsg.textContent = 'asking your browser to pick a device…';

  try {
    const device = await navigator.bluetooth.requestDevice({ filters: [{ services: [BLE_SERVICE_UUID] }] });
    progressMsg.textContent = `connecting to ${device.name}…`;
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(BLE_SERVICE_UUID);
    const cfgChar = await service.getCharacteristic(BLE_CHAR_CONFIG_UUID);
    const statusChar = await service.getCharacteristic(BLE_CHAR_STATUS_UUID);
    await statusChar.startNotifications();
    statusChar.addEventListener('characteristicvaluechanged', (ev) => {
      const s = new TextDecoder().decode(ev.target.value);
      progressMsg.textContent = humanizeStatus(s);
      if (s === 'connected') {
        setTimeout(() => {
          document.getElementById('add-dialog').close();
          toast(`device paired with ${pairingAppliances.length} appliance${pairingAppliances.length === 1 ? '' : 's'}`);
          fetchDevices().then(() => { renderHome(); if (floorplan) floorplan.refresh(); });
        }, 1500);
      }
    });
    progressMsg.textContent = 'sending config to device…';
    const config = {
      ssid, pass, name, user_id: userSub, room_id: roomId,
      appliances: pairingAppliances.map(a => ({
        id: a.id, type: a.type, name: a.name, room_id: roomId,
      })),
    };
    await cfgChar.writeValue(new TextEncoder().encode(JSON.stringify(config)));
    progressMsg.textContent = 'config sent. device is connecting…';
  } catch (err) {
    progressMsg.textContent = 'pairing failed: ' + err.message;
  }
};
function humanizeStatus(s) {
  return ({
    waiting:               'device ready, waiting for config…',
    applying:              'device received config, applying…',
    connecting_wifi:       'device connecting to your WiFi…',
    connecting_mqtt:       'device connecting to the cloud…',
    connected:             '✓ paired! device is online.',
    error_wifi:            '✗ WiFi connection failed. wrong SSID or password?',
    error_mqtt:            '✗ cloud connection failed. did you attach the IoT policy to this identity?',
    error_invalid_json:    '✗ internal error sending config.',
    error_missing_fields:  '✗ internal error sending config.',
  })[s] || s;
}

// ============================================================
// SETTINGS DIALOG
// ============================================================
function openSettings() {
  document.getElementById('settings-name').value = currentAppliance.name;
  const sel = document.getElementById('settings-room');
  sel.innerHTML = '<option value="">(unassigned)</option>';
  for (const r of rooms.values()) {
    const opt = document.createElement('option');
    opt.value = r.room_id; opt.textContent = `${r.icon || '🚪'} ${r.name}`;
    if ((currentAppliance.room_id || '') === r.room_id) opt.selected = true;
    sel.appendChild(opt);
  }
  document.getElementById('settings-ac-section').style.display = currentAppliance.type === 'ac' ? '' : 'none';
  if (currentAppliance.type === 'ac') {
    const brandSel = document.getElementById('settings-brand');
    brandSel.innerHTML = '';
    for (const b of BRANDS) {
      const opt = document.createElement('option');
      opt.value = b.v; opt.textContent = b.name;
      if ((currentAppliance.state?.protocol ?? 16) === b.v) opt.selected = true;
      brandSel.appendChild(opt);
    }
  }
  // Render schedules for this appliance inside the dialog
  renderApplianceSchedules(currentDevice, currentAppliance.id);
  document.getElementById('settings-dialog').showModal();
}
document.getElementById('settings-cancel').onclick = (e) => { e.preventDefault(); document.getElementById('settings-dialog').close(); };

document.getElementById('settings-add-appliance').onclick = (e) => {
  e.preventDefault();
  document.getElementById('settings-dialog').close();
  openAddApplianceDialog();
};

// ---- Add appliance to existing device ----
function openAddApplianceDialog() {
  document.getElementById('new-appliance-name').value = '';
  document.getElementById('new-appliance-type').value = 'fan';
  const sel = document.getElementById('new-appliance-room');
  sel.innerHTML = '<option value="">(unassigned)</option>';
  for (const r of rooms.values()) {
    const opt = document.createElement('option');
    opt.value = r.room_id; opt.textContent = `${r.icon || '🚪'} ${r.name}`;
    const d = devices.get(currentDevice);
    if ((d?.room_id || '') === r.room_id) opt.selected = true;
    sel.appendChild(opt);
  }
  document.getElementById('add-appliance-dialog').showModal();
}
document.getElementById('new-appliance-cancel').onclick = (e) => {
  e.preventDefault();
  document.getElementById('add-appliance-dialog').close();
};
document.getElementById('new-appliance-save').onclick = async (e) => {
  e.preventDefault();
  const type = document.getElementById('new-appliance-type').value;
  const name = document.getElementById('new-appliance-name').value.trim();
  const roomId = document.getElementById('new-appliance-room').value || '';
  if (!name) { toast('name the appliance'); return; }
  if (!isDeviceLive(devices.get(currentDevice))) {
    toast('device is offline — bring it online to add an appliance', 3500);
    return;
  }
  const id = uid();
  cmd('add_appliance', { id, type, name, room_id: roomId });
  document.getElementById('add-appliance-dialog').close();
  toast('appliance added');
  // The device will republish its state with the new appliance — IoT Rule
  // updates DynamoDB and our subscription updates the UI within a few seconds.
};
document.getElementById('settings-save').onclick = (e) => {
  e.preventDefault();
  const newName = document.getElementById('settings-name').value.trim();
  const newRoom = document.getElementById('settings-room').value || '';
  if (newName && newName !== currentAppliance.name)         cmd('rename', { appliance_id: currentAppliance.id, name: newName });
  if (newRoom !== (currentAppliance.room_id || ''))         cmd('assign_room', { appliance_id: currentAppliance.id, room_id: newRoom });
  if (currentAppliance.type === 'ac') {
    const newProto = Number(document.getElementById('settings-brand').value);
    if (newProto !== currentAppliance.state.protocol)       cmd('set_ac', { appliance_id: currentAppliance.id, protocol: newProto });
  }
  document.getElementById('settings-dialog').close();
};
document.getElementById('settings-delete').onclick = async (e) => {
  e.preventDefault();
  const d = devices.get(currentDevice);
  const isLast = (d.appliances || []).length <= 1;
  if (isLast) {
    if (!confirm("This is the device's last appliance — factory-resetting the whole device. Continue?")) return;
    cmd('factory_reset', {});
    try { await dynamoDelete(DEVICES_TABLE, 'user_id', userSub, 'device_id', currentDevice); } catch {}
    devices.delete(currentDevice);
    toast('device reset and removed');
  } else {
    if (!confirm(`Remove appliance "${currentAppliance.name}" from this device?`)) return;
    cmd('delete_appliance', { id: currentAppliance.id });
    toast('appliance removed');
  }
  document.getElementById('settings-dialog').close();
  currentDevice = null; currentAppliance = null;
  show('screen-home'); renderHome();
};

// ============================================================
// 2D EDITOR TOOLBAR — pan/zoom buttons
// ============================================================
document.getElementById('zoom-in').onclick  = () => floorplan?.zoomIn();
document.getElementById('zoom-out').onclick = () => floorplan?.zoomOut();
document.getElementById('zoom-fit').onclick = () => floorplan?.fitToContent();

// ============================================================
// SCENES + SCHEDULES — helpers
// ============================================================
//
// An "action" is { device_id, type, payload }
//   type 'set_ac':    payload { appliance_id, power, mode, degrees, fanspeed, protocol }
//   type 'send_raw':  payload { appliance_id, button }

// Render existing actions in a scene/schedule editor with their description
// and a remove button. The `actions` array is mutated in place.
function renderActions(containerId, actions, refresh) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  if (actions.length === 0) {
    container.innerHTML = '<p class="dim small">No actions yet. Click "+ add action" below.</p>';
    return;
  }
  actions.forEach((a, idx) => {
    const row = document.createElement('div');
    row.className = 'action-row';
    const d = devices.get(a.device_id);
    const ap = d?.appliances?.find(x => x.id === a.payload?.appliance_id);
    let desc = `${d?.name || '(unknown device)'} → ${ap?.name || '(unknown appliance)'}`;
    if (a.type === 'set_ac') {
      const p = a.payload || {};
      if (p.power === false) desc += ' · turn OFF';
      else {
        const m = AC_MODES.find(x => x.v === p.mode);
        desc += ` · ON @ ${p.degrees || '?'}°C ${m?.label || ''}`;
      }
    } else if (a.type === 'send_raw') {
      desc += ` · press "${a.payload?.button || '?'}"`;
    }
    row.innerHTML = `
      <div class="ax-desc">${escapeHTML(desc)}</div>
      <button class="ax-remove" title="remove">✕</button>
    `;
    row.querySelector('.ax-remove').onclick = (e) => {
      e.preventDefault();
      actions.splice(idx, 1);
      refresh();
    };
    container.appendChild(row);
  });
}

// Render an inline action-picker form into a host element. When the user picks
// values and clicks "Add", call onAdd({ device_id, type, payload }). The form
// removes itself on either Add or Cancel.
function showActionPickerForm(hostId, onAdd) {
  const host = document.getElementById(hostId);
  if (!host) return;

  if (devices.size === 0) {
    host.innerHTML = '<p class="dim small">No devices paired yet. Pair one first from the home screen.</p>';
    setTimeout(() => host.innerHTML = '', 3500);
    return;
  }

  // Build form HTML
  const deviceOpts = [...devices.values()].map(d =>
    `<option value="${escapeHTML(d.device_id)}">${escapeHTML(d.name || d.device_id)}</option>`
  ).join('');

  host.innerHTML = `
    <div class="action-picker">
      <div class="ap-row">
        <label>Device</label>
        <select class="ap-device">${deviceOpts}</select>
      </div>
      <div class="ap-row">
        <label>Appliance</label>
        <select class="ap-appliance"></select>
      </div>
      <div class="ap-params"></div>
      <div class="ap-buttons">
        <button class="ghost ap-cancel">cancel</button>
        <button class="primary ap-add">add action</button>
      </div>
    </div>
  `;

  const $device    = host.querySelector('.ap-device');
  const $appliance = host.querySelector('.ap-appliance');
  const $params    = host.querySelector('.ap-params');

  function rebuildAppliances() {
    const d = devices.get($device.value);
    const aps = d?.appliances || [];
    $appliance.innerHTML = aps.map(a =>
      `<option value="${escapeHTML(a.id)}">${escapeHTML(a.name)} (${a.type})</option>`
    ).join('');
    rebuildParams();
  }

  function rebuildParams() {
    const d = devices.get($device.value);
    const ap = d?.appliances?.find(x => x.id === $appliance.value);
    if (!ap) { $params.innerHTML = ''; return; }
    if (ap.type === 'ac') {
      const modeOpts = AC_MODES.map(m => `<option value="${m.v}">${m.icon} ${m.label}</option>`).join('');
      const fanOpts  = AC_FANS.map(f  => `<option value="${f.v}">${f.label}</option>`).join('');
      $params.innerHTML = `
        <div class="ap-row">
          <label>Action</label>
          <div class="pill-group">
            <button class="active" data-power="on"  type="button">Turn ON</button>
            <button data-power="off" type="button">Turn OFF</button>
          </div>
        </div>
        <div class="ap-on-params">
          <div class="ap-row">
            <label>Mode</label>
            <select class="ap-mode">${modeOpts}</select>
          </div>
          <div class="ap-row">
            <label>Temp (°C)</label>
            <input class="ap-temp" type="number" min="16" max="30" value="24">
          </div>
          <div class="ap-row">
            <label>Fan speed</label>
            <select class="ap-fan">${fanOpts}</select>
          </div>
        </div>
      `;
      const onParams = $params.querySelector('.ap-on-params');
      $params.querySelectorAll('[data-power]').forEach(b => {
        b.onclick = (e) => {
          e.preventDefault();
          $params.querySelectorAll('[data-power]').forEach(x => x.classList.remove('active'));
          b.classList.add('active');
          onParams.style.display = b.dataset.power === 'on' ? '' : 'none';
        };
      });
    } else {
      // fan / generic — need a button picker. Pull from currentButtons if this is the
      // currently-open appliance (it'll have the latest list). Otherwise the user has to type.
      const showingThis = currentAppliance && currentAppliance.id === ap.id;
      const knownButtons = showingThis ? currentButtons : [];
      const btnOpts = knownButtons.length
        ? knownButtons.map(b => `<option value="${escapeHTML(b)}">${escapeHTML(b)}</option>`).join('')
        : '<option value="">(no learned buttons known — type one below)</option>';
      $params.innerHTML = `
        <div class="ap-row">
          <label>Button to press</label>
          <select class="ap-button">${btnOpts}</select>
        </div>
        <div class="ap-row">
          <label class="dim small">or type a button name</label>
          <input class="ap-button-custom" type="text" placeholder="e.g. power">
        </div>
      `;
    }
  }

  $device.onchange    = rebuildAppliances;
  $appliance.onchange = rebuildParams;
  rebuildAppliances();

  host.querySelector('.ap-cancel').onclick = (e) => { e.preventDefault(); host.innerHTML = ''; };
  host.querySelector('.ap-add').onclick = (e) => {
    e.preventDefault();
    const deviceId = $device.value;
    const applianceId = $appliance.value;
    const d  = devices.get(deviceId);
    const ap = d?.appliances?.find(x => x.id === applianceId);
    if (!ap) return;

    let action;
    if (ap.type === 'ac') {
      const isOn = $params.querySelector('[data-power].active')?.dataset.power === 'on';
      if (!isOn) {
        action = {
          device_id: deviceId, type: 'set_ac',
          payload: { appliance_id: applianceId, power: false, protocol: ap.state?.protocol || 16 },
        };
      } else {
        const mode  = Number($params.querySelector('.ap-mode').value);
        const temp  = Number($params.querySelector('.ap-temp').value) || 24;
        const fan   = Number($params.querySelector('.ap-fan').value);
        action = {
          device_id: deviceId, type: 'set_ac',
          payload: {
            appliance_id: applianceId,
            power: true,
            protocol: ap.state?.protocol || 16,
            mode, degrees: temp, fanspeed: fan, swingv: 255,
          },
        };
      }
    } else {
      const btn = ($params.querySelector('.ap-button-custom').value || $params.querySelector('.ap-button').value || '').trim();
      if (!btn) { toast('pick or type a button name'); return; }
      action = {
        device_id: deviceId, type: 'send_raw',
        payload: { appliance_id: applianceId, button: btn },
      };
    }
    onAdd(action);
    host.innerHTML = '';
  };
}

// ============================================================
// SCENE DIALOG
// ============================================================
let editingScene = null;
function openSceneDialog(sceneId) {
  editingScene = sceneId ? { ...scenes.get(sceneId), actions: [...(scenes.get(sceneId).actions || [])] }
                         : { scene_id: uid(), name: '', icon: '✨', actions: [] };
  document.getElementById('scene-dialog-title').textContent = sceneId ? 'Edit scene' : 'New scene';
  document.getElementById('scene-delete').style.display = sceneId ? '' : 'none';
  document.getElementById('scene-name').value = editingScene.name || '';
  document.querySelectorAll('#scene-icon-picker button').forEach(b => {
    b.classList.toggle('selected', b.dataset.icon === (editingScene.icon || '✨'));
    b.onclick = (e) => {
      e.preventDefault();
      document.querySelectorAll('#scene-icon-picker button').forEach(x => x.classList.remove('selected'));
      b.classList.add('selected');
      editingScene.icon = b.dataset.icon;
    };
  });
  renderActions('scene-actions', editingScene.actions, () => renderActions('scene-actions', editingScene.actions, () => {}));
  document.getElementById('scene-dialog').showModal();
}
document.getElementById('scene-cancel').onclick = (e) => { e.preventDefault(); document.getElementById('scene-dialog').close(); };
document.getElementById('scene-add-action').onclick = (e) => {
  e.preventDefault();
  // Create or reuse a host for the inline form right above the button
  let host = document.getElementById('scene-action-form-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'scene-action-form-host';
    document.getElementById('scene-add-action').before(host);
  }
  showActionPickerForm('scene-action-form-host', (action) => {
    editingScene.actions.push(action);
    renderActions('scene-actions', editingScene.actions, () => renderActions('scene-actions', editingScene.actions, () => {}));
  });
};
document.getElementById('scene-save').onclick = async (e) => {
  e.preventDefault();
  editingScene.name = document.getElementById('scene-name').value.trim();
  if (!editingScene.name) { toast('name the scene'); return; }
  const item = {
    user_id: userSub,
    scene_id: editingScene.scene_id,
    name: editingScene.name,
    icon: editingScene.icon || '✨',
    actions: editingScene.actions || [],
  };
  try {
    await dynamoPut(SCENES_TABLE, item);
    scenes.set(item.scene_id, item);
    document.getElementById('scene-dialog').close();
    renderScenes();
    toast('scene saved');
  } catch (err) {
    toast('save failed: ' + err.message, 4000);
  }
};
document.getElementById('scene-delete').onclick = async (e) => {
  e.preventDefault();
  if (!confirm('Delete this scene?')) return;
  try {
    await dynamoDelete(SCENES_TABLE, 'user_id', userSub, 'scene_id', editingScene.scene_id);
    scenes.delete(editingScene.scene_id);
    document.getElementById('scene-dialog').close();
    renderScenes();
  } catch (err) {
    toast('delete failed: ' + err.message, 4000);
  }
};
document.getElementById('add-scene-btn').onclick = () => openSceneDialog(null);

// ============================================================
// SCHEDULE DIALOG
// ============================================================
let editingSchedule = null;
function openScheduleDialog(scheduleId) {
  editingSchedule = scheduleId
    ? { ...schedules.get(scheduleId), actions: [...(schedules.get(scheduleId).actions || [])], days: [...(schedules.get(scheduleId).days || [])] }
    : { schedule_id: uid(), name: '', time: '07:00', days: [1,2,3,4,5], enabled: true, actions: [], timezone: 'Asia/Singapore' };
  document.getElementById('schedule-dialog-title').textContent = scheduleId ? 'Edit schedule' : 'New schedule';
  document.getElementById('schedule-delete').style.display = scheduleId ? '' : 'none';
  document.getElementById('schedule-name').value = editingSchedule.name || '';
  document.getElementById('schedule-time').value = editingSchedule.time || '07:00';
  document.getElementById('schedule-enabled').checked = editingSchedule.enabled !== false;
  document.querySelectorAll('#schedule-days button').forEach(b => {
    const d = Number(b.dataset.day);
    b.classList.toggle('selected', editingSchedule.days.includes(d));
    b.onclick = (e) => {
      e.preventDefault();
      const i = editingSchedule.days.indexOf(d);
      if (i >= 0) editingSchedule.days.splice(i, 1);
      else        editingSchedule.days.push(d);
      b.classList.toggle('selected');
    };
  });
  renderActions('schedule-actions', editingSchedule.actions, () => renderActions('schedule-actions', editingSchedule.actions, () => {}));
  document.getElementById('schedule-dialog').showModal();
}
document.getElementById('schedule-cancel').onclick = (e) => { e.preventDefault(); document.getElementById('schedule-dialog').close(); };
document.getElementById('schedule-add-action').onclick = (e) => {
  e.preventDefault();
  showActionPickerForm('schedule-action-form-host', (action) => {
    editingSchedule.actions.push(action);
    renderActions('schedule-actions', editingSchedule.actions, () => renderActions('schedule-actions', editingSchedule.actions, () => {}));
  });
};
document.getElementById('schedule-save').onclick = async (e) => {
  e.preventDefault();
  editingSchedule.name = document.getElementById('schedule-name').value.trim();
  editingSchedule.time = document.getElementById('schedule-time').value;
  editingSchedule.enabled = document.getElementById('schedule-enabled').checked;
  if (!editingSchedule.name) { toast('name the schedule'); return; }
  if (!editingSchedule.time) { toast('set a time'); return; }
  if (editingSchedule.days.length === 0) { toast('pick at least one day'); return; }
  if (editingSchedule.actions.length === 0) { toast('add at least one action'); return; }
  const item = {
    user_id: userSub,
    schedule_id: editingSchedule.schedule_id,
    name:     editingSchedule.name,
    time:     editingSchedule.time,
    days:     editingSchedule.days,
    enabled:  editingSchedule.enabled,
    actions:  editingSchedule.actions,
    timezone: editingSchedule.timezone || 'Asia/Singapore',
  };
  try {
    await dynamoPut(SCHEDULES_TABLE, item);
    schedules.set(item.schedule_id, item);
    document.getElementById('schedule-dialog').close();
    renderSchedules();
    toast('schedule saved');
  } catch (err) {
    toast('save failed: ' + err.message + ' (check that ac-remote-schedules table exists and IAM is updated)', 5000);
  }
};
document.getElementById('schedule-delete').onclick = async (e) => {
  e.preventDefault();
  if (!confirm('Delete this schedule?')) return;
  try {
    await dynamoDelete(SCHEDULES_TABLE, 'user_id', userSub, 'schedule_id', editingSchedule.schedule_id);
    schedules.delete(editingSchedule.schedule_id);
    document.getElementById('schedule-dialog').close();
    renderSchedules();
  } catch (err) {
    toast('delete failed: ' + err.message, 4000);
  }
};
document.getElementById('add-schedule-btn').onclick = () => openScheduleDialog(null);

// ============================================================
// APPLIANCE-SCOPED SCHEDULES
// ============================================================
// Schedules logically belong to an appliance — opened from the settings dialog.
// The device + appliance are known from context so the form is much simpler:
// just time / days / action params (no device or appliance picker).

let editingApplianceSchedule = null;
let editingApplianceContext  = null;  // { deviceId, applianceId }

// Return all schedules whose first action targets this device+appliance.
function schedulesForAppliance(deviceId, applianceId) {
  const out = [];
  for (const s of schedules.values()) {
    const a = (s.actions || [])[0];
    if (a?.device_id === deviceId && a?.payload?.appliance_id === applianceId) out.push(s);
  }
  return out.sort((a, b) => (a.time || '').localeCompare(b.time || ''));
}

// Called from openSettings() to render the in-dialog schedule list.
function renderApplianceSchedules(deviceId, applianceId) {
  const host = document.getElementById('settings-schedules-list');
  if (!host) return;
  const list = schedulesForAppliance(deviceId, applianceId);
  if (list.length === 0) {
    host.innerHTML = '<p class="dim small">No schedules for this appliance. Tap "+ add" to create one.</p>';
    return;
  }
  const dayLetters = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  host.innerHTML = '';
  for (const s of list) {
    const card = document.createElement('div');
    card.className = 'mini-schedule';
    const days = (s.days || []).map(d => dayLetters[d]).join(' · ');
    card.innerHTML = `
      <div class="ms-time">${escapeHTML(s.time || '--:--')}</div>
      <div class="ms-meta">
        <div class="ms-name">${escapeHTML(s.name || 'Unnamed')}</div>
        <div class="ms-days dim small">${escapeHTML(days || 'no days set')}</div>
      </div>
      <div class="sc-toggle ${s.enabled === false ? '' : 'on'}" title="toggle"></div>
    `;
    card.querySelector('.sc-toggle').onclick = (e) => { e.stopPropagation(); toggleSchedule(s.schedule_id); setTimeout(() => renderApplianceSchedules(deviceId, applianceId), 200); };
    card.onclick = () => openApplianceScheduleDialog(deviceId, applianceId, s.schedule_id);
    host.appendChild(card);
  }
}

// Open the per-appliance schedule dialog. If scheduleId is null we create new.
function openApplianceScheduleDialog(deviceId, applianceId, scheduleId) {
  const d = devices.get(deviceId);
  const ap = d?.appliances?.find(a => a.id === applianceId);
  if (!ap) return;
  editingApplianceContext = { deviceId, applianceId };

  const existing = scheduleId ? schedules.get(scheduleId) : null;
  editingApplianceSchedule = existing
    ? { ...existing, days: [...(existing.days || [])], actions: [...(existing.actions || [])] }
    : { schedule_id: uid(), name: '', time: '07:00', days: [1,2,3,4,5], enabled: true, actions: [], timezone: 'Asia/Singapore' };

  document.getElementById('ash-title').textContent = scheduleId ? 'Edit schedule' : 'New schedule';
  document.getElementById('ash-subtitle').textContent = `${APPLIANCE_ICONS[ap.type] || ''} ${ap.name}`;
  document.getElementById('ash-delete').style.display = scheduleId ? '' : 'none';
  document.getElementById('ash-name').value = editingApplianceSchedule.name || '';
  document.getElementById('ash-time').value = editingApplianceSchedule.time || '07:00';
  document.getElementById('ash-enabled').checked = editingApplianceSchedule.enabled !== false;

  // Days picker
  document.querySelectorAll('#ash-days button').forEach(b => {
    const d = Number(b.dataset.day);
    b.classList.toggle('selected', editingApplianceSchedule.days.includes(d));
    b.onclick = (e) => {
      e.preventDefault();
      const i = editingApplianceSchedule.days.indexOf(d);
      if (i >= 0) editingApplianceSchedule.days.splice(i, 1);
      else        editingApplianceSchedule.days.push(d);
      b.classList.toggle('selected');
    };
  });

  // Show the right action section based on appliance type
  const acSection  = document.getElementById('ash-ac-section');
  const btnSection = document.getElementById('ash-button-section');
  acSection.style.display  = ap.type === 'ac' ? '' : 'none';
  btnSection.style.display = ap.type === 'ac' ? 'none' : '';

  if (ap.type === 'ac') {
    const modeSel = document.getElementById('ash-mode');
    modeSel.innerHTML = AC_MODES.map(m => `<option value="${m.v}">${m.icon} ${m.label}</option>`).join('');
    const fanSel = document.getElementById('ash-fan');
    fanSel.innerHTML = AC_FANS.map(f => `<option value="${f.v}">${f.label}</option>`).join('');
    // Pre-fill from existing action if editing
    const existingAction = (editingApplianceSchedule.actions[0]?.payload) || {};
    const isOn = existingAction.power !== false;
    document.getElementById('ash-power-on').classList.toggle('active', isOn);
    document.getElementById('ash-power-off').classList.toggle('active', !isOn);
    document.getElementById('ash-on-params').style.display = isOn ? '' : 'none';
    if (existingAction.mode != null)    modeSel.value = String(existingAction.mode);
    if (existingAction.degrees != null) document.getElementById('ash-temp').value = existingAction.degrees;
    if (existingAction.fanspeed != null) fanSel.value = String(existingAction.fanspeed);
    document.getElementById('ash-power-on').onclick = (e) => {
      e.preventDefault();
      document.getElementById('ash-power-on').classList.add('active');
      document.getElementById('ash-power-off').classList.remove('active');
      document.getElementById('ash-on-params').style.display = '';
    };
    document.getElementById('ash-power-off').onclick = (e) => {
      e.preventDefault();
      document.getElementById('ash-power-off').classList.add('active');
      document.getElementById('ash-power-on').classList.remove('active');
      document.getElementById('ash-on-params').style.display = 'none';
    };
  } else {
    // fan / generic — populate button picker from currentButtons (which has the latest list)
    const sel = document.getElementById('ash-button');
    if (currentButtons.length > 0) {
      sel.innerHTML = currentButtons.map(b => `<option value="${escapeHTML(b)}">${escapeHTML(b)}</option>`).join('');
    } else {
      sel.innerHTML = '<option value="">(no buttons learned yet — open the control screen and teach one first)</option>';
    }
    const existingBtn = editingApplianceSchedule.actions[0]?.payload?.button;
    if (existingBtn) sel.value = existingBtn;
  }

  document.getElementById('appliance-schedule-dialog').showModal();
}

document.getElementById('ash-cancel').onclick = (e) => {
  e.preventDefault();
  document.getElementById('appliance-schedule-dialog').close();
};
document.getElementById('ash-save').onclick = async (e) => {
  e.preventDefault();
  const name = document.getElementById('ash-name').value.trim();
  const time = document.getElementById('ash-time').value;
  if (!name) { toast('name the schedule'); return; }
  if (!time) { toast('set a time'); return; }
  if (editingApplianceSchedule.days.length === 0) { toast('pick at least one day'); return; }

  const { deviceId, applianceId } = editingApplianceContext;
  const d = devices.get(deviceId);
  const ap = d?.appliances?.find(a => a.id === applianceId);
  if (!ap) return;

  // Build the single action for this appliance
  let action;
  if (ap.type === 'ac') {
    const isOn = document.getElementById('ash-power-on').classList.contains('active');
    if (!isOn) {
      action = {
        device_id: deviceId, type: 'set_ac',
        payload: { appliance_id: applianceId, power: false, protocol: ap.state?.protocol || 16 },
      };
    } else {
      const mode = Number(document.getElementById('ash-mode').value);
      const temp = Number(document.getElementById('ash-temp').value) || 24;
      const fan  = Number(document.getElementById('ash-fan').value);
      action = {
        device_id: deviceId, type: 'set_ac',
        payload: {
          appliance_id: applianceId, power: true,
          protocol: ap.state?.protocol || 16,
          mode, degrees: temp, fanspeed: fan, swingv: 255,
        },
      };
    }
  } else {
    const btn = document.getElementById('ash-button').value;
    if (!btn) { toast('pick a learned button (teach one from the control screen first if needed)'); return; }
    action = {
      device_id: deviceId, type: 'send_raw',
      payload: { appliance_id: applianceId, button: btn },
    };
  }

  const item = {
    user_id: userSub,
    schedule_id: editingApplianceSchedule.schedule_id,
    name, time,
    days: editingApplianceSchedule.days,
    enabled: document.getElementById('ash-enabled').checked,
    actions: [action],
    timezone: editingApplianceSchedule.timezone || 'Asia/Singapore',
  };
  try {
    await dynamoPut(SCHEDULES_TABLE, item);
    schedules.set(item.schedule_id, item);
    document.getElementById('appliance-schedule-dialog').close();
    renderApplianceSchedules(deviceId, applianceId);
    renderSchedules();
    toast('schedule saved');
  } catch (err) {
    toast('save failed: ' + err.message + ' (check that ac-remote-schedules table exists and IAM is updated)', 5000);
  }
};
document.getElementById('ash-delete').onclick = async (e) => {
  e.preventDefault();
  if (!confirm('Delete this schedule?')) return;
  try {
    await dynamoDelete(SCHEDULES_TABLE, 'user_id', userSub, 'schedule_id', editingApplianceSchedule.schedule_id);
    schedules.delete(editingApplianceSchedule.schedule_id);
    document.getElementById('appliance-schedule-dialog').close();
    const { deviceId, applianceId } = editingApplianceContext || {};
    if (deviceId) renderApplianceSchedules(deviceId, applianceId);
    renderSchedules();
  } catch (err) {
    toast('delete failed: ' + err.message, 4000);
  }
};

// Wire the "+ add schedule" button inside the settings dialog
document.getElementById('settings-add-schedule').onclick = (e) => {
  e.preventDefault();
  if (!currentDevice || !currentAppliance) return;
  openApplianceScheduleDialog(currentDevice, currentAppliance.id, null);
};
