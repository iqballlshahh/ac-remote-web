import {
  signInWithGoogle, getIdentityId,
  mqttConnect, mqttSubscribe, mqttPublish, mqttDisconnect,
  dynamoQuery, dynamoDelete,
} from './aws-iot.js';

const DEVICES_TABLE = 'ac-remote-devices';

const cfg = window.APP_CONFIG;

// ---------- enums mirror IRremoteESP8266 ----------
const MODES = [
  { v: 1, label: 'Auto', key: 'auto' },
  { v: 2, label: 'Cool', key: 'cool' },
  { v: 4, label: 'Dry',  key: 'dry'  },
  { v: 5, label: 'Fan',  key: 'fan'  },
  { v: 3, label: 'Heat', key: 'heat' },
];
const FANS = [
  { v: 0, label: 'Auto' },
  { v: 2, label: 'Low'  },
  { v: 3, label: 'Med'  },
  { v: 4, label: 'High' },
];
// Values match IRremoteESP8266 decode_type_t. If you don't see your brand,
// check src/IRremoteESP8266.h in the library — many more are supported.
const BRANDS = [
  { v: 16, name: 'Daikin' },
  { v: 53, name: 'Daikin 2' },
  { v: 20, name: 'Mitsubishi (AC)' },
  { v: 59, name: 'Mitsubishi Heavy 88' },
  { v: 60, name: 'Mitsubishi Heavy 152' },
  { v: 49, name: 'Panasonic AC' },
  { v: 24, name: 'Gree' },
  { v: 51, name: 'LG (LG2)' },
  { v: 46, name: 'Samsung AC' },
  { v: 32, name: 'Toshiba AC' },
  { v: 40, name: 'Hitachi AC' },
  { v: 33, name: 'Fujitsu AC' },
  { v: 34, name: 'Midea' },
  { v: 18, name: 'Kelvinator' },
  { v: 37, name: 'Carrier AC' },
  { v: 45, name: 'Whirlpool AC' },
  { v: 38, name: 'Haier AC' },
  { v: 44, name: 'Haier YRW02' },
  { v: 48, name: 'Electra AC' },
  { v: 54, name: 'Vestel AC' },
  { v: 55, name: 'Teco' },
  { v: 57, name: 'TCL 112' },
  { v: 27, name: 'Argo' },
  { v: 15, name: 'Coolix (generic)' },
];

// ---------- state ----------
let user        = null;       // { name, email, picture }
let userSub     = null;       // Cognito identity ID
let devices     = new Map();  // device_id -> { name, state, online, lastSeen }
let currentDevice = null;     // device_id while on control screen
let currentButtons = [];      // raw button names

// ============================================================
// SCREENS
// ============================================================
function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));
}
function setLoading(msg) { document.getElementById('loading-msg').textContent = msg; show('screen-loading'); }
function toast(msg, ms = 2000) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

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

  // Try silent restore using a previously cached ID token (within its 1-hour validity)
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

    setLoading('loading devices');
    try {
      const items = await dynamoQuery(DEVICES_TABLE, 'user_id', userSub);
      for (const item of items) {
        devices.set(item.device_id, {
          ...item,
          online: !!item.online,
          lastSeen: Number(item.updated_at) || Date.now(),
        });
      }
    } catch (err) {
      console.error('Failed to load devices from DynamoDB:', err);
      toast('could not load devices: ' + err.message, 4000);
    }

    show('screen-devices');
    refreshDeviceList();
  } catch (err) {
    console.error(err);
    toast('sign-in failed: ' + err.message, 4000);
    sessionStorage.removeItem('google_id_token');
    show('screen-login');
  }
}

function setupSubscriptions() {
  mqttSubscribe(`ac-remote/users/${userSub}/devices/+/state`, (topic, msg) => {
    const id = topic.split('/')[4];
    const prev = devices.get(id) || {};
    devices.set(id, {
      ...prev,
      ...msg,
      online: !!msg.online,
      lastSeen: Date.now(),
    });
    refreshDeviceList();
    if (currentDevice === id) renderControl();
  });
  mqttSubscribe(`ac-remote/users/${userSub}/devices/+/event`, (topic, msg) => {
    const id = topic.split('/')[4];
    handleEvent(id, msg);
  });
}

// ============================================================
// DEVICE LIST
// ============================================================
function refreshDeviceList() {
  const list = document.getElementById('device-list');
  list.innerHTML = '';
  if (devices.size === 0) {
    const e = document.createElement('div');
    e.className = 'empty-state';
    e.textContent = 'no devices yet — tap + add device to get started';
    list.appendChild(e);
    return;
  }
  for (const [id, d] of devices) {
    const online = d.online && (Date.now() - d.lastSeen < 60000);
    const card = document.createElement('div');
    card.className = 'device-card' + (online ? '' : ' offline');
    card.onclick = () => openControl(id);
    const summary = d.power
      ? `${Math.round(d.degrees)}° · ${(MODES.find(m=>m.v===d.mode)||{}).label || ''}`.toLowerCase()
      : (online ? 'off' : 'offline');
    card.innerHTML = `
      <div class="icon">❄</div>
      <div>
        <div class="name">${escapeHtml(d.name || 'AC')}</div>
        <div class="sub">${id.slice(0, 11)}</div>
      </div>
      <div class="summary">${summary}</div>
    `;
    list.appendChild(card);
  }
}

document.getElementById('logout-btn').onclick = () => {
  mqttDisconnect();
  devices.clear(); userSub = null; user = null;
  sessionStorage.removeItem('google_id_token');
  google.accounts.id.disableAutoSelect();
  show('screen-login');
};

// ============================================================
// ADD DEVICE — Web Bluetooth pairing
// ============================================================
const BLE_SERVICE_UUID     = '7c30b8e2-cabb-4a2e-8d05-e44bd6a3a8e1';
const BLE_CHAR_CONFIG_UUID = '7c30b8e2-cabb-4a2e-8d05-e44bd6a3a8e2';
const BLE_CHAR_STATUS_UUID = '7c30b8e2-cabb-4a2e-8d05-e44bd6a3a8e3';

document.getElementById('add-device-btn').onclick = () => {
  document.getElementById('pair-name').value = '';
  document.getElementById('pair-ssid').value = '';
  document.getElementById('pair-pass').value = '';
  document.getElementById('add-progress').style.display = 'none';
  document.getElementById('add-dialog').showModal();
};
document.getElementById('add-cancel').onclick = (e) => {
  e.preventDefault();
  document.getElementById('add-dialog').close();
};
document.getElementById('add-submit').onclick = async (e) => {
  e.preventDefault();
  const name = document.getElementById('pair-name').value.trim();
  const ssid = document.getElementById('pair-ssid').value.trim();
  const pass = document.getElementById('pair-pass').value;
  if (!name || !ssid) { toast('fill in name and WiFi SSID'); return; }

  if (!navigator.bluetooth) {
    toast('Web Bluetooth not supported in this browser', 4000);
    return;
  }

  const progress = document.getElementById('add-progress');
  const progressMsg = document.getElementById('add-progress-msg');
  progress.style.display = 'block';
  progressMsg.textContent = 'Asking your browser to pick a device…';

  try {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [BLE_SERVICE_UUID] }],
    });
    progressMsg.textContent = `Connecting to ${device.name}…`;

    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(BLE_SERVICE_UUID);
    const cfgChar = await service.getCharacteristic(BLE_CHAR_CONFIG_UUID);
    const statusChar = await service.getCharacteristic(BLE_CHAR_STATUS_UUID);

    // Subscribe to status notifications so we can show progress live
    await statusChar.startNotifications();
    statusChar.addEventListener('characteristicvaluechanged', (ev) => {
      const s = new TextDecoder().decode(ev.target.value);
      progressMsg.textContent = humanizeStatus(s);
      if (s === 'connected') {
        setTimeout(() => {
          document.getElementById('add-dialog').close();
          toast('device paired!');
        }, 1500);
      }
    });

    progressMsg.textContent = 'Sending config to device…';
    const config = {
      ssid, pass, name,
      user_id: userSub,
    };
    const payload = new TextEncoder().encode(JSON.stringify(config));
    await cfgChar.writeValue(payload);

    progressMsg.textContent = 'Config sent. Device is connecting to WiFi…';
    // The device will notify us via the status characteristic as it progresses.
    // If notifications stop arriving (e.g. device disconnects BLE on success),
    // the user can close the dialog manually.
  } catch (err) {
    progressMsg.textContent = 'Pairing failed: ' + err.message;
  }
};

function humanizeStatus(s) {
  switch (s) {
    case 'waiting':         return 'Device ready, waiting for config…';
    case 'applying':        return 'Device received config, applying…';
    case 'connecting_wifi': return 'Device connecting to your WiFi…';
    case 'connecting_mqtt': return 'Device connecting to the cloud…';
    case 'connected':       return '✓ Paired! Device is online.';
    case 'error_wifi':      return '✗ WiFi connection failed. Wrong SSID or password?';
    case 'error_mqtt':      return '✗ Cloud connection failed. Device may still come online — check your device list in a minute.';
    case 'error_invalid_json':
    case 'error_missing_fields': return '✗ Internal error sending config.';
    default: return s;
  }
}

// ============================================================
// CONTROL SCREEN
// ============================================================
function openControl(id) {
  currentDevice = id;
  currentButtons = [];
  document.querySelector('.control-screen').classList.remove('mode-cool','mode-heat','mode-dry','mode-fan','mode-auto');
  show('screen-control');
  renderControl();
  buildGrids();
  // Ask device for its current button list
  cmd('list_buttons', {});
}

document.getElementById('back-btn').onclick = () => {
  currentDevice = null;
  show('screen-devices');
};

function cmd(type, payload) {
  mqttPublish(`ac-remote/users/${userSub}/devices/${currentDevice}/cmd`, { type, payload });
}

function renderControl() {
  const d = devices.get(currentDevice);
  if (!d) return;
  document.getElementById('control-title').textContent = d.name || 'AC';
  document.getElementById('temp-num').textContent = Math.round(d.degrees ?? 24);
  document.getElementById('power-pill').textContent = d.power ? 'on' : 'off';
  document.getElementById('power-pill').classList.toggle('on', !!d.power);
  document.getElementById('power-btn').classList.toggle('on', !!d.power);
  document.getElementById('brand-pill').textContent =
    (BRANDS.find(b => b.v === d.protocol) || {}).name || d.protocol_name || 'unknown';

  const m = MODES.find(x => x.v === d.mode) || MODES[1];
  document.getElementById('mode-pill').textContent = m.label.toLowerCase();
  document.querySelector('.control-screen').classList.remove('mode-cool','mode-heat','mode-dry','mode-fan','mode-auto');
  document.querySelector('.control-screen').classList.add('mode-' + m.key);

  const f = FANS.find(x => x.v === d.fanspeed) || FANS[0];
  document.getElementById('fan-pill').textContent = f.label.toLowerCase();

  document.querySelector('.temp-big').classList.toggle('off', !d.power);

  for (const b of document.querySelectorAll('.opt[data-mode]'))
    b.classList.toggle('active', Number(b.dataset.mode) === d.mode);
  for (const b of document.querySelectorAll('.opt[data-fan]'))
    b.classList.toggle('active', Number(b.dataset.fan) === d.fanspeed);
}

function buildGrids() {
  const mg = document.getElementById('mode-grid'); mg.innerHTML = '';
  for (const m of MODES) {
    const b = document.createElement('button');
    b.className = 'opt'; b.dataset.mode = m.v; b.textContent = m.label;
    b.onclick = () => cmd('set_ac', { mode: m.v, power: true });
    mg.appendChild(b);
  }
  const fg = document.getElementById('fan-grid'); fg.innerHTML = '';
  for (const f of FANS) {
    const b = document.createElement('button');
    b.className = 'opt'; b.dataset.fan = f.v; b.textContent = f.label;
    b.onclick = () => cmd('set_ac', { fanspeed: f.v });
    fg.appendChild(b);
  }
}

document.getElementById('temp-up').onclick   = () => {
  const d = devices.get(currentDevice); if (!d) return;
  cmd('set_ac', { degrees: Math.min(30, (d.degrees ?? 24) + 1) });
};
document.getElementById('temp-down').onclick = () => {
  const d = devices.get(currentDevice); if (!d) return;
  cmd('set_ac', { degrees: Math.max(16, (d.degrees ?? 24) - 1) });
};
document.getElementById('power-btn').onclick = () => {
  const d = devices.get(currentDevice); if (!d) return;
  cmd('set_ac', { power: !d.power });
};

// ---------- tabs ----------
document.querySelectorAll('.tab').forEach(t => {
  t.onclick = () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
    document.querySelectorAll('.tab-pane').forEach(p =>
      p.classList.toggle('active', p.id === 'tab-' + t.dataset.tab));
  };
});

// ============================================================
// EVENTS (from device)
// ============================================================
function handleEvent(deviceId, msg) {
  if (deviceId !== currentDevice) return;
  const t = msg.type;
  if (t === 'button_list') {
    currentButtons = msg.payload.buttons || [];
    renderCustomButtons();
  } else if (t === 'learn_result') {
    if (msg.payload.success) {
      toast(`learned ${msg.payload.button} (${msg.payload.edges} edges)`);
      cmd('list_buttons', {});
      document.getElementById('learn-dialog').close();
    } else {
      document.getElementById('learn-status').textContent = msg.payload.error || 'learn failed';
    }
  } else if (t === 'send_result') {
    if (msg.payload.success) toast('sent ' + msg.payload.button);
    else toast('button not found');
  } else if (t === 'delete_result') {
    cmd('list_buttons', {});
  }
}

function renderCustomButtons() {
  const g = document.getElementById('custom-grid');
  g.innerHTML = '';
  if (currentButtons.length === 0) {
    g.innerHTML = '<div class="empty-custom">no learned buttons yet</div>';
    return;
  }
  for (const name of currentButtons) {
    const b = document.createElement('button');
    b.className = 'custom-btn';
    b.innerHTML = `${escapeHtml(name)}<button class="del-x">×</button>`;
    b.onclick = (e) => {
      if (e.target.classList.contains('del-x')) {
        if (confirm(`delete button "${name}"?`)) cmd('delete_button', { button: name });
        return;
      }
      cmd('send_raw', { button: name });
      toast('sending ' + name);
    };
    g.appendChild(b);
  }
}

// ---------- learn dialog ----------
document.getElementById('learn-btn').onclick = () => {
  document.getElementById('learn-name').value = '';
  document.getElementById('learn-status').textContent = 'After clicking start, press the button on your real remote within 12 seconds.';
  document.getElementById('learn-dialog').showModal();
};
document.getElementById('learn-cancel').onclick = (e) => {
  e.preventDefault(); document.getElementById('learn-dialog').close();
};
document.getElementById('learn-start').onclick = (e) => {
  e.preventDefault();
  const name = document.getElementById('learn-name').value.trim();
  if (!name) { toast('name the button first'); return; }
  document.getElementById('learn-status').textContent = `waiting for IR signal for "${name}"…`;
  cmd('learn', { button: name });
};

// ============================================================
// SETTINGS DIALOG
// ============================================================
document.getElementById('settings-btn').onclick = () => {
  const d = devices.get(currentDevice); if (!d) return;
  document.getElementById('settings-name').value = d.name || '';
  const sel = document.getElementById('settings-protocol');
  sel.innerHTML = '';
  for (const b of BRANDS) {
    const o = document.createElement('option');
    o.value = b.v; o.textContent = b.name;
    if (b.v === d.protocol) o.selected = true;
    sel.appendChild(o);
  }
  document.getElementById('settings-dialog').showModal();
};
document.getElementById('settings-cancel').onclick = (e) => { e.preventDefault(); document.getElementById('settings-dialog').close(); };
document.getElementById('settings-save').onclick = (e) => {
  e.preventDefault();
  const name = document.getElementById('settings-name').value.trim();
  const protocol = Number(document.getElementById('settings-protocol').value);
  if (name) cmd('rename', { name });
  cmd('set_ac', { protocol });
  document.getElementById('settings-dialog').close();
};
document.getElementById('settings-reset').onclick = async () => {
  if (!confirm('factory reset — wipes WiFi, owner, and learned buttons. continue?')) return;
  cmd('factory_reset', {});
  // Also remove from DynamoDB so it doesn't reappear in the device list.
  try {
    await dynamoDelete(DEVICES_TABLE, 'user_id', userSub, 'device_id', currentDevice);
  } catch (err) {
    console.error('Failed to delete device from DB:', err);
  }
  devices.delete(currentDevice);
  document.getElementById('settings-dialog').close();
  toast('device reset and removed');
  show('screen-devices');
  refreshDeviceList();
};

// ============================================================
// utils
// ============================================================
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g,
    c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
