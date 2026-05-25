import {
  signInWithGoogle, getIdentityId,
  mqttConnect, mqttSubscribe, mqttPublish, mqttDisconnect,
  dynamoQuery, dynamoPut, dynamoUpdate, dynamoDelete,
} from './aws-iot.js';

import { Floorplan } from './floorplan.js';

const DEVICES_TABLE = 'ac-remote-devices';
const ROOMS_TABLE   = 'ac-remote-rooms';

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
let rooms          = new Map();   // room_id -> room object
let devices        = new Map();   // device_id -> device object
let currentRoomId  = null;
let currentDevice  = null;
let currentAppliance = null;
let currentButtons = [];
let homeMode       = 'view';      // 'view' (3D) | 'edit' (2D)
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
  toast._t = setTimeout(() => el.style.display = 'none', ms);
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
  rooms.clear(); devices.clear();
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
    if (r.success) {
      toast(`learned "${r.button}" (${r.edges} edges)`);
      if (currentDevice === deviceId && currentAppliance?.id === r.appliance_id) {
        cmd('list_buttons', { appliance_id: currentAppliance.id });
      }
    } else {
      toast(`learn failed: ${r.error || 'unknown'}`, 3500);
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

function cmd(type, payload = {}) {
  if (!currentDevice) {
    console.warn('[cmd] no currentDevice set, dropping', type, payload);
    return;
  }
  const d = devices.get(currentDevice);
  // Pass-through commands work even if device is offline (the user is
  // explicitly trying to clean things up).
  const passThrough = new Set(['factory_reset', 'delete_appliance']);
  if (!passThrough.has(type) && !isDeviceLive(d)) {
    console.warn('[cmd] device offline, dropping', type, payload, { lastSeen: d?.lastSeen, online: d?.online });
    toast(`device is offline — command not sent`, 3000);
    return;
  }
  const topic = `ac-remote/users/${userSub}/devices/${currentDevice}/cmd`;
  console.log('[cmd]', type, payload);
  mqttPublish(topic, { type, payload });
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

  if (floorplan) {
    floorplan.setMode(homeMode);
  }
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
  const isPowerOn = false; // we don't actually know fan power state — display as ambiguous
  const mainButtons = FAN_BUTTONS.slice(0, 4); // power, speed +/-, auto
  const oscButtons  = FAN_BUTTONS.slice(4);    // 45, 90, 180
  root.innerHTML = `
    <div class="fan-stage">
      <div class="fan-hero ${isPowerOn ? 'on' : ''}">
        <div class="ac-mode-label">${escapeHTML(currentAppliance.name)}</div>
        <div class="fan-rotor">🌀</div>
        <p class="dim small">Tap a button to send the learned IR code.</p>
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
      <div class="generic-grid" style="margin-top:14px">
        <div class="add-button-tile" id="fan-learn-btn">+ learn a button</div>
      </div>
    </div>
  `;
  root.querySelectorAll('[data-fan-btn]').forEach(el => {
    el.onclick = () => {
      const name = el.dataset.fanBtn;
      if (!learned.has(name)) { toast(`"${name}" not learned yet — tap "learn a button" below`, 3500); return; }
      cmd('send_raw', { appliance_id: currentAppliance.id, button: name });
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
function openLearnDialog() {
  document.getElementById('learn-name').value = '';
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
  document.getElementById('pair-appliance-name').value = '';
  document.getElementById('add-progress').style.display = 'none';
  const sel = document.getElementById('pair-room');
  sel.innerHTML = '<option value="">(unassigned)</option>';
  for (const r of rooms.values()) {
    const opt = document.createElement('option');
    opt.value = r.room_id; opt.textContent = `${r.icon || '🚪'} ${r.name}`;
    sel.appendChild(opt);
  }
  document.getElementById('add-dialog').showModal();
};
document.getElementById('add-cancel').onclick = (e) => { e.preventDefault(); document.getElementById('add-dialog').close(); };
document.getElementById('add-submit').onclick = async (e) => {
  e.preventDefault();
  const name = document.getElementById('pair-name').value.trim();
  const ssid = document.getElementById('pair-ssid').value.trim();
  const pass = document.getElementById('pair-pass').value;
  const roomId = document.getElementById('pair-room').value || '';
  const apType = document.getElementById('pair-appliance-type').value;
  const apName = document.getElementById('pair-appliance-name').value.trim() || ({ ac: 'AC', fan: 'Fan', generic: 'Remote' }[apType] || 'Appliance');
  if (!name || !ssid) { toast('fill in device name and WiFi SSID'); return; }
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
          toast('device paired!');
          fetchDevices().then(() => { renderHome(); if (floorplan) floorplan.refresh(); });
        }, 1500);
      }
    });
    progressMsg.textContent = 'sending config to device…';
    const config = {
      ssid, pass, name, user_id: userSub, room_id: roomId,
      appliances: [{ id: 'default', type: apType, name: apName, room_id: roomId }],
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
