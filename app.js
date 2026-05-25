import {
  signInWithGoogle, getIdentityId,
  mqttConnect, mqttSubscribe, mqttPublish, mqttDisconnect,
  dynamoQuery, dynamoPut, dynamoUpdate, dynamoDelete,
} from './aws-iot.js';

const DEVICES_TABLE = 'ac-remote-devices';
const ROOMS_TABLE   = 'ac-remote-rooms';

const cfg = window.APP_CONFIG;

// ---------- enums mirror IRremoteESP8266 ----------
const AC_MODES = [
  { v: 1, label: 'Auto', key: 'auto' },
  { v: 2, label: 'Cool', key: 'cool' },
  { v: 4, label: 'Dry',  key: 'dry'  },
  { v: 5, label: 'Fan',  key: 'fan'  },
  { v: 3, label: 'Heat', key: 'heat' },
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

// Predefined fan buttons (must match these names when learned)
const FAN_BUTTONS = [
  { name: 'power',     label: 'Power',     icon: '⏻' },
  { name: 'speed_up',  label: 'Speed +',   icon: '＋' },
  { name: 'speed_dn',  label: 'Speed −',   icon: '−' },
  { name: 'auto',      label: 'Auto mode', icon: '🔄' },
  { name: 'osc_45',    label: 'Oscillate 45°',  icon: '↔' },
  { name: 'osc_90',    label: 'Oscillate 90°',  icon: '↔↔' },
  { name: 'osc_180',   label: 'Oscillate 180°', icon: '↔↔↔' },
];

// ---------- state ----------
let user           = null;
let userSub        = null;
let rooms          = new Map();   // room_id -> { name, icon }
let devices        = new Map();   // device_id -> full row
let currentRoomId  = null;
let currentDevice  = null;
let currentAppliance = null;      // appliance object inside currentDevice
let currentButtons = [];          // learned button names for currentAppliance

// ============================================================
// UTIL
// ============================================================
function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.style.display = 'none');
  document.getElementById(id).style.display = '';
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
function uid() {
  return Math.random().toString(36).slice(2, 10);
}
function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

// ============================================================
// LOGIN
// ============================================================
window.addEventListener('load', () => {
  if (!window.google || !cfg.GOOGLE_CLIENT_ID || cfg.GOOGLE_CLIENT_ID.startsWith('REPLACE')) {
    document.querySelector('#screen-login p').textContent =
      'Edit config.js with your Google Client ID before deploying.';
    return;
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

    show('screen-home');
    renderHome();
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
  google.accounts.id.disableAutoSelect();
  show('screen-login');
};

// ============================================================
// DATA LOADING + MQTT SUBSCRIPTIONS
// ============================================================
async function fetchRooms() {
  try {
    const items = await dynamoQuery(ROOMS_TABLE, 'user_id', userSub);
    rooms.clear();
    for (const it of items) rooms.set(it.room_id, it);
  } catch (e) {
    console.error('fetchRooms failed:', e);
    toast('could not load rooms', 4000);
  }
}
async function fetchDevices() {
  try {
    const items = await dynamoQuery(DEVICES_TABLE, 'user_id', userSub);
    devices.clear();
    for (const it of items) {
      // Migration: old-format rows have flat power/mode/degrees fields and no `appliances` array
      if (!Array.isArray(it.appliances)) {
        it.appliances = [{
          id: 'default',
          type: 'ac',
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
      devices.set(it.device_id, it);
    }
  } catch (e) {
    console.error('fetchDevices failed:', e);
    toast('could not load devices', 4000);
  }
}

function setupSubscriptions() {
  mqttSubscribe(`ac-remote/users/${userSub}/devices/+/state`, (topic, msg) => {
    const id = topic.split('/')[4];
    const prev = devices.get(id) || {};
    devices.set(id, { ...prev, ...msg, online: !!msg.online, lastSeen: Date.now() });
    // Re-render whatever screen is showing
    if (document.getElementById('screen-home').style.display !== 'none')   renderHome();
    if (document.getElementById('screen-room').style.display !== 'none')   renderRoom();
    if (document.getElementById('screen-control').style.display !== 'none') renderControl();
  });
  mqttSubscribe(`ac-remote/users/${userSub}/devices/+/event`, (topic, msg) => {
    handleEvent(topic.split('/')[4], msg);
  });
}

function handleEvent(deviceId, ev) {
  if (!ev || !ev.type) return;
  if (ev.type === 'learn_result') {
    const r = ev.payload || {};
    if (r.success) {
      toast(`learned "${r.button}" (${r.edges} edges)`);
      // refresh button list for currently open appliance
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

// Helper to publish a cmd to the currently selected device
function cmd(type, payload = {}) {
  if (!currentDevice) return;
  const topic = `ac-remote/users/${userSub}/devices/${currentDevice}/cmd`;
  mqttPublish(topic, { type, payload });
}

// ============================================================
// HOME SCREEN — rooms + unassigned devices
// ============================================================
function renderHome() {
  const grid = document.getElementById('rooms-grid');
  const unassigned = document.getElementById('unassigned-list');
  grid.innerHTML = '';
  unassigned.innerHTML = '';

  // Sort rooms by name
  const rs = [...rooms.values()].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  for (const r of rs) {
    const count = countAppliancesInRoom(r.room_id);
    const card = document.createElement('div');
    card.className = 'room-card';
    card.innerHTML = `
      <div class="room-icon">${r.icon || '🚪'}</div>
      <div class="room-name">${escapeHTML(r.name)}</div>
      <div class="room-count">${count} appliance${count === 1 ? '' : 's'}</div>
    `;
    card.onclick = () => openRoom(r.room_id);
    grid.appendChild(card);
  }

  // "+ add room" card at the end
  const add = document.createElement('div');
  add.className = 'add-room-card';
  add.textContent = '+';
  add.onclick = () => openRoomDialog(null);
  grid.appendChild(add);

  // Devices/appliances not assigned to any room (i.e. room_id empty or pointing at deleted room)
  const orphans = [];
  for (const d of devices.values()) {
    for (const a of d.appliances || []) {
      const rid = a.room_id || d.room_id || '';
      if (!rid || !rooms.has(rid)) orphans.push({ device: d, appliance: a });
    }
  }
  if (orphans.length === 0) {
    unassigned.innerHTML = '<p class="dim center small">all appliances are assigned to rooms.</p>';
  } else {
    for (const { device, appliance } of orphans) {
      unassigned.appendChild(applianceTile(device, appliance));
    }
  }
}

function countAppliancesInRoom(roomId) {
  let n = 0;
  for (const d of devices.values())
    for (const a of d.appliances || [])
      if ((a.room_id || d.room_id) === roomId) n++;
  return n;
}
function escapeHTML(s) {
  return String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

// ============================================================
// ROOM SCREEN
// ============================================================
function openRoom(roomId) {
  currentRoomId = roomId;
  const r = rooms.get(roomId);
  document.getElementById('room-name').textContent = `${r.icon || '🚪'} ${r.name}`;
  show('screen-room');
  renderRoom();
}
function renderRoom() {
  if (!currentRoomId) return;
  const container = document.getElementById('room-appliances');
  const empty     = document.getElementById('room-empty');
  container.innerHTML = '';
  let count = 0;
  for (const d of devices.values()) {
    for (const a of d.appliances || []) {
      if ((a.room_id || d.room_id) === currentRoomId) {
        container.appendChild(applianceTile(d, a));
        count++;
      }
    }
  }
  empty.style.display = count === 0 ? '' : 'none';
}
document.getElementById('room-back-btn').onclick = () => { currentRoomId = null; show('screen-home'); renderHome(); };
document.getElementById('room-edit-btn').onclick = () => openRoomDialog(currentRoomId);

function applianceTile(device, appliance) {
  const el = document.createElement('div');
  el.className = 'appliance-tile';
  const isAC = appliance.type === 'ac';
  const state = appliance.state || {};
  const isOn = state.power === true;
  if (isOn) el.classList.add('power-on');
  let summary = '';
  if (isAC) {
    summary = isOn
      ? `${(AC_MODES.find(m => m.v === state.mode) || {}).label || ''} · ${state.degrees || '?'}°C`
      : 'off';
  } else if (appliance.type === 'fan') {
    summary = 'fan controls';
  } else {
    summary = 'custom buttons';
  }
  el.innerHTML = `
    <div class="ap-icon">${APPLIANCE_ICONS[appliance.type] || '🎛️'}</div>
    <div class="ap-meta">
      <div class="ap-name">${escapeHTML(appliance.name)}</div>
      <div class="ap-state">${escapeHTML(summary)}</div>
    </div>
    <div class="ap-online ${device.online ? 'on' : ''}" title="${device.online ? 'online' : 'offline'}"></div>
  `;
  el.onclick = () => openControl(device.device_id, appliance.id);
  return el;
}

// ============================================================
// CONTROL SCREEN (renders different layout per appliance type)
// ============================================================
function openControl(deviceId, applianceId) {
  currentDevice = deviceId;
  const d = devices.get(deviceId);
  currentAppliance = (d.appliances || []).find(a => a.id === applianceId);
  if (!currentAppliance) return;
  document.getElementById('control-title').textContent = `${APPLIANCE_ICONS[currentAppliance.type] || ''} ${currentAppliance.name}`;
  show('screen-control');
  renderControl();
  // Request the learned-button list for fan/generic
  if (currentAppliance.type !== 'ac') cmd('list_buttons', { appliance_id: currentAppliance.id });
}
document.getElementById('control-back-btn').onclick = () => {
  currentDevice = null; currentAppliance = null; currentButtons = [];
  if (currentRoomId) { show('screen-room'); renderRoom(); }
  else               { show('screen-home'); renderHome(); }
};
document.getElementById('control-settings-btn').onclick = () => openSettings();

function renderControl() {
  if (!currentAppliance) return;
  // refresh from devices Map (state may have changed via MQTT)
  const d = devices.get(currentDevice);
  currentAppliance = (d.appliances || []).find(a => a.id === currentAppliance.id) || currentAppliance;
  const body = document.getElementById('control-body');
  body.innerHTML = '';
  if (currentAppliance.type === 'ac')      renderAcControl(body);
  else if (currentAppliance.type === 'fan') renderFanControl(body);
  else                                       renderGenericControl(body);
}

// ---- AC ----
function renderAcControl(root) {
  const st = currentAppliance.state || {};
  const power = !!st.power;
  const temp = st.degrees ?? 24;
  const mode = st.mode ?? 1;
  const fan  = st.fanspeed ?? 0;

  root.innerHTML = `
    <div class="fan-power-tile">
      <div class="power-state">${power ? 'ON' : 'OFF'} · ${temp}°C</div>
      <button class="power-toggle ${power ? 'on' : ''}" id="ac-power">${power ? 'turn off' : 'turn on'}</button>
    </div>
    <div class="fan-row">
      <div class="row-label">Temp</div>
      <div class="row-buttons">
        <button id="t-dn">−</button>
        <span style="padding:0 10px;font-weight:600">${temp}°C</span>
        <button id="t-up">+</button>
      </div>
    </div>
    <div class="fan-row">
      <div class="row-label">Mode</div>
      <div class="row-buttons">
        ${AC_MODES.map(m => `<button class="${m.v===mode?'active':''}" data-mode="${m.v}">${m.label}</button>`).join('')}
      </div>
    </div>
    <div class="fan-row">
      <div class="row-label">Fan</div>
      <div class="row-buttons">
        ${AC_FANS.map(f => `<button class="${f.v===fan?'active':''}" data-fan="${f.v}">${f.label}</button>`).join('')}
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
  // Optimistic local update
  Object.assign(currentAppliance.state, changes);
  // Always send protocol + power so device has full picture
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

// ---- FAN ----
function renderFanControl(root) {
  const learned = new Set(currentButtons);
  const tiles = FAN_BUTTONS.map(b => {
    const isLearned = learned.has(b.name);
    return `<div class="custom-btn" data-fan-btn="${b.name}" style="${isLearned ? '' : 'opacity:.5'}">
      <div class="btn-icon">${b.icon}</div>${escapeHTML(b.label)}
      <div class="dim small" style="margin-top:4px">${isLearned ? '' : '(not learned)'}</div>
    </div>`;
  }).join('');
  root.innerHTML = `
    <p class="dim small" style="padding:0 4px">
      Tap a button to send. To teach the fan a new command, open settings →
      learn button — name it exactly one of: ${FAN_BUTTONS.map(b => `<code>${b.name}</code>`).join(', ')}.
    </p>
    <div class="custom-buttons">
      ${tiles}
      <div class="add-button-tile" id="fan-learn-btn">+ learn button</div>
    </div>
  `;
  root.querySelectorAll('[data-fan-btn]').forEach(el => {
    el.onclick = () => {
      const name = el.dataset.fanBtn;
      if (!learned.has(name)) { toast(`"${name}" not learned yet — see settings`, 3000); return; }
      cmd('send_raw', { appliance_id: currentAppliance.id, button: name });
    };
  });
  document.getElementById('fan-learn-btn').onclick = () => openLearnDialog();
}

// ---- GENERIC ----
function renderGenericControl(root) {
  if (currentButtons.length === 0) {
    root.innerHTML = `
      <p class="dim center">no buttons learned yet. tap below to teach this device its first button.</p>
      <div class="custom-buttons">
        <div class="add-button-tile" id="gen-learn-btn">+ learn button</div>
      </div>
    `;
    document.getElementById('gen-learn-btn').onclick = () => openLearnDialog();
    return;
  }
  const tiles = currentButtons.map(n =>
    `<div class="custom-btn" data-gen-btn="${escapeHTML(n)}">
       <div class="btn-icon">🔘</div>${escapeHTML(n)}
     </div>`
  ).join('');
  root.innerHTML = `
    <div class="custom-buttons">
      ${tiles}
      <div class="add-button-tile" id="gen-learn-btn">+ learn button</div>
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
  s.textContent = 'waiting for IR signal — aim your remote at the receiver and press the button within 12 seconds…';
};

// ============================================================
// ROOM DIALOG (add / edit)
// ============================================================
let editingRoomId = null;
function openRoomDialog(roomId) {
  editingRoomId = roomId;
  const isEdit = !!roomId;
  document.getElementById('room-dialog-title').textContent = isEdit ? 'Edit room' : 'Add a room';
  document.getElementById('room-delete').style.display = isEdit ? '' : 'none';
  const r = isEdit ? rooms.get(roomId) : { name: '', icon: '🚪' };
  document.getElementById('room-name-input').value = r.name || '';
  document.querySelectorAll('#room-icon-picker button').forEach(b => {
    b.classList.toggle('selected', b.dataset.icon === (r.icon || '🚪'));
    b.onclick = (e) => {
      e.preventDefault();
      document.querySelectorAll('#room-icon-picker button').forEach(x => x.classList.remove('selected'));
      b.classList.add('selected');
    };
  });
  document.getElementById('room-dialog').showModal();
}
document.getElementById('add-room-btn').onclick = () => openRoomDialog(null);
document.getElementById('room-cancel').onclick = (e) => { e.preventDefault(); document.getElementById('room-dialog').close(); };
document.getElementById('room-save').onclick = async (e) => {
  e.preventDefault();
  const name = document.getElementById('room-name-input').value.trim();
  const icon = document.querySelector('#room-icon-picker button.selected')?.dataset.icon || '🚪';
  if (!name) { toast('name the room'); return; }
  const roomId = editingRoomId || uid();
  const item = { user_id: userSub, room_id: roomId, name, icon };
  try {
    await dynamoPut(ROOMS_TABLE, item);
    rooms.set(roomId, item);
    document.getElementById('room-dialog').close();
    if (document.getElementById('screen-room').style.display !== 'none' && currentRoomId === roomId) {
      document.getElementById('room-name').textContent = `${icon} ${name}`;
    }
    renderHome();
  } catch (err) {
    toast('save failed: ' + err.message, 4000);
  }
};
document.getElementById('room-delete').onclick = async (e) => {
  e.preventDefault();
  if (!editingRoomId) return;
  if (!confirm('delete this room? appliances in this room will become unassigned.')) return;
  try {
    await dynamoDelete(ROOMS_TABLE, 'user_id', userSub, 'room_id', editingRoomId);
    rooms.delete(editingRoomId);
    document.getElementById('room-dialog').close();
    if (currentRoomId === editingRoomId) { currentRoomId = null; show('screen-home'); }
    renderHome();
  } catch (err) {
    toast('delete failed: ' + err.message, 4000);
  }
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

  // Populate room selector
  const sel = document.getElementById('pair-room');
  sel.innerHTML = '<option value="">(no room)</option>';
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

  if (!name || !ssid) { toast('fill in name and WiFi SSID'); return; }
  if (!navigator.bluetooth) { toast('Web Bluetooth not supported in this browser', 4000); return; }

  const progress     = document.getElementById('add-progress');
  const progressMsg  = document.getElementById('add-progress-msg');
  progress.style.display = 'block';
  progressMsg.textContent = 'asking your browser to pick a device…';

  try {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [BLE_SERVICE_UUID] }],
    });
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
          fetchDevices().then(renderHome);
        }, 1500);
      }
    });

    progressMsg.textContent = 'sending config to device…';
    const config = {
      ssid, pass, name, user_id: userSub, room_id: roomId,
      appliances: [{ id: 'default', type: apType, name: apName, room_id: roomId }],
    };
    const payload = new TextEncoder().encode(JSON.stringify(config));
    await cfgChar.writeValue(payload);
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
    error_mqtt:            '✗ cloud connection failed. check if you ran the attach-policy step.',
    error_invalid_json:    '✗ internal error sending config.',
    error_missing_fields:  '✗ internal error sending config.',
  })[s] || s;
}

// ============================================================
// SETTINGS DIALOG
// ============================================================
function openSettings() {
  document.getElementById('settings-name').value = currentAppliance.name;
  // Room picker
  const sel = document.getElementById('settings-room');
  sel.innerHTML = '<option value="">(no room)</option>';
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
document.getElementById('settings-save').onclick = (e) => {
  e.preventDefault();
  const newName = document.getElementById('settings-name').value.trim();
  const newRoom = document.getElementById('settings-room').value || '';
  if (newName && newName !== currentAppliance.name) {
    cmd('rename', { appliance_id: currentAppliance.id, name: newName });
  }
  if (newRoom !== (currentAppliance.room_id || '')) {
    cmd('assign_room', { appliance_id: currentAppliance.id, room_id: newRoom });
  }
  if (currentAppliance.type === 'ac') {
    const newProto = Number(document.getElementById('settings-brand').value);
    if (newProto !== currentAppliance.state.protocol) {
      cmd('set_ac', { appliance_id: currentAppliance.id, protocol: newProto });
    }
  }
  document.getElementById('settings-dialog').close();
};
document.getElementById('settings-delete').onclick = async (e) => {
  e.preventDefault();
  const d = devices.get(currentDevice);
  const isLast = (d.appliances || []).length <= 1;
  if (isLast) {
    if (!confirm('this is the device\'s last appliance — factory-resetting the whole device. continue?')) return;
    cmd('factory_reset', {});
    try { await dynamoDelete(DEVICES_TABLE, 'user_id', userSub, 'device_id', currentDevice); } catch {}
    devices.delete(currentDevice);
    toast('device reset and removed');
  } else {
    if (!confirm(`remove appliance "${currentAppliance.name}" from this device?`)) return;
    cmd('delete_appliance', { id: currentAppliance.id });
    toast('appliance removed');
  }
  document.getElementById('settings-dialog').close();
  currentDevice = null; currentAppliance = null;
  show('screen-home');
  renderHome();
};
