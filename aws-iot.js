// Cognito Identity + SigV4 + MQTT 3.1.1 over WebSocket.
// No external dependencies. Pure browser code.

const cfg = window.APP_CONFIG;

let creds = null;
let identityId = null;
let googleIdToken = null;

const COGNITO_ENDPOINT = `https://cognito-identity.${cfg.AWS_REGION}.amazonaws.com/`;
const KEEPALIVE_SEC = 60;

// ============================================================
// COGNITO — federate Google ID token to AWS temp credentials
// ============================================================
async function cognitoCall(target, body) {
  const resp = await fetch(COGNITO_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': `AWSCognitoIdentityService.${target}`,
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) {
    let msg = text;
    try {
      const j = JSON.parse(text);
      msg = `${j.__type || 'Error'}: ${j.message || j.Message || text}`;
    } catch {}
    throw new Error(`Cognito ${target} failed (${resp.status}): ${msg}`);
  }
  return JSON.parse(text);
}

export async function signInWithGoogle(idToken) {
  googleIdToken = idToken;
  const loginKey = 'accounts.google.com';
  const idRes = await cognitoCall('GetId', {
    IdentityPoolId: cfg.COGNITO_IDENTITY_POOL_ID,
    Logins: { [loginKey]: idToken },
  });
  identityId = idRes.IdentityId;
  const credRes = await cognitoCall('GetCredentialsForIdentity', {
    IdentityId: identityId,
    Logins: { [loginKey]: idToken },
  });
  creds = {
    accessKeyId:     credRes.Credentials.AccessKeyId,
    secretAccessKey: credRes.Credentials.SecretKey,
    sessionToken:    credRes.Credentials.SessionToken,
    expiration:      credRes.Credentials.Expiration,
  };
  return { identityId, creds };
}

export function getIdentityId() { return identityId; }
export function getCreds()      { return creds; }

// ============================================================
// SigV4 — sign an MQTT-over-WSS URL for AWS IoT Core
// ============================================================
async function hmac(keyData, msg) {
  const key = await crypto.subtle.importKey(
    'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)));
}
async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function toHex(bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function signIotWebSocketUrl() {
  const region = cfg.AWS_REGION, host = cfg.IOT_ENDPOINT;
  const service = 'iotdevicegateway', method = 'GET', path = '/mqtt';
  const now = new Date();
  const amzDate   = now.toISOString().replace(/[:\-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const credScope = `${dateStamp}/${region}/${service}/aws4_request`;

  const queryParams = {
    'X-Amz-Algorithm':     'AWS4-HMAC-SHA256',
    'X-Amz-Credential':    `${creds.accessKeyId}/${credScope}`,
    'X-Amz-Date':          amzDate,
    'X-Amz-Expires':       '86400',
    'X-Amz-SignedHeaders': 'host',
  };
  const canonicalQuery = Object.keys(queryParams).sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(queryParams[k])}`).join('&');

  const canonicalRequest = [
    method, path, canonicalQuery,
    `host:${host}\n`, 'host', await sha256Hex(''),
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate, credScope, await sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate    = await hmac(new TextEncoder().encode('AWS4' + creds.secretAccessKey), dateStamp);
  const kRegion  = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, 'aws4_request');
  const sig      = toHex(await hmac(kSigning, stringToSign));

  let url = `wss://${host}${path}?${canonicalQuery}&X-Amz-Signature=${sig}`;
  if (creds.sessionToken) url += `&X-Amz-Security-Token=${encodeURIComponent(creds.sessionToken)}`;
  return url;
}

// ============================================================
// MQTT 3.1.1 wire protocol — hand-rolled, just what we need
// ============================================================
function concat(...arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

function encVarLen(n) {
  const bytes = [];
  do {
    let b = n & 0x7F;
    n >>>= 7;
    if (n > 0) b |= 0x80;
    bytes.push(b);
  } while (n > 0);
  return new Uint8Array(bytes);
}

function decVarLen(data, off) {
  let mult = 1, value = 0, i = off, byte;
  do {
    if (i >= data.length) return null;
    byte = data[i++];
    value += (byte & 0x7F) * mult;
    mult *= 128;
    if (mult > 128 ** 3) return null;
  } while (byte & 0x80);
  return { length: value, bytesRead: i - off };
}

function encStr(s) {
  const utf = new TextEncoder().encode(s);
  const out = new Uint8Array(2 + utf.length);
  out[0] = (utf.length >> 8) & 0xff;
  out[1] = utf.length & 0xff;
  out.set(utf, 2);
  return out;
}

function decStr(data, off) {
  const len = (data[off] << 8) | data[off + 1];
  const str = new TextDecoder().decode(data.subarray(off + 2, off + 2 + len));
  return { str, bytesRead: 2 + len };
}

function packCONNECT(clientId) {
  const varHdr = concat(
    encStr('MQTT'),
    new Uint8Array([0x04, 0x02, (KEEPALIVE_SEC >> 8) & 0xff, KEEPALIVE_SEC & 0xff]),
  );
  const payload = encStr(clientId);
  const remaining = varHdr.length + payload.length;
  return concat(new Uint8Array([0x10]), encVarLen(remaining), varHdr, payload);
}

function packSUBSCRIBE(packetId, topic) {
  const pid = new Uint8Array([(packetId >> 8) & 0xff, packetId & 0xff]);
  const payload = concat(encStr(topic), new Uint8Array([0x00]));
  const remaining = pid.length + payload.length;
  return concat(new Uint8Array([0x82]), encVarLen(remaining), pid, payload);
}

function packPUBLISH(topic, body) {
  const topicBytes = encStr(topic);
  const payloadBytes = new TextEncoder().encode(body);
  const remaining = topicBytes.length + payloadBytes.length;
  return concat(new Uint8Array([0x30]), encVarLen(remaining), topicBytes, payloadBytes);
}

const PINGREQ    = new Uint8Array([0xC0, 0x00]);
const DISCONNECT = new Uint8Array([0xE0, 0x00]);

// ============================================================
// MQTT client API — public, used by app.js
// ============================================================
let socket = null;
const handlers = new Map();
let pingTimer = null;
let nextPacketId = 1;
let recvBuffer = new Uint8Array(0);

function topicMatches(pattern, topic) {
  const pp = pattern.split('/'), tp = topic.split('/');
  for (let i = 0; i < pp.length; i++) {
    if (pp[i] === '#') return true;
    if (pp[i] === '+') continue;
    if (pp[i] !== tp[i]) return false;
  }
  return pp.length === tp.length;
}

function handleIncomingPacket(packetType, body) {
  if (packetType === 0x30) {        // PUBLISH (QoS 0)
    const ts = decStr(body, 0);
    const topic = ts.str;
    const payload = new TextDecoder().decode(body.subarray(ts.bytesRead));
    let json = null;
    try { json = JSON.parse(payload); } catch {}
    for (const [pattern, handler] of handlers) {
      if (topicMatches(pattern, topic)) handler(topic, json ?? payload);
    }
  }
  // SUBACK (0x90), PINGRESP (0xD0) — ignored
}

export async function mqttConnect() {
  const url = await signIotWebSocketUrl();
  const clientId = 'web-' + Math.random().toString(36).slice(2, 10);

  return new Promise((resolve, reject) => {
    socket = new WebSocket(url, ['mqttv3.1.1']);
    socket.binaryType = 'arraybuffer';

    socket.onopen = () => socket.send(packCONNECT(clientId));

    socket.onmessage = (ev) => {
      recvBuffer = concat(recvBuffer, new Uint8Array(ev.data));
      while (recvBuffer.length >= 2) {
        const packetType = recvBuffer[0] & 0xF0;
        const lenInfo = decVarLen(recvBuffer, 1);
        if (!lenInfo) break;
        const total = 1 + lenInfo.bytesRead + lenInfo.length;
        if (recvBuffer.length < total) break;
        const body = recvBuffer.subarray(1 + lenInfo.bytesRead, total);

        if (packetType === 0x20) {  // CONNACK
          const rc = body[1];
          if (rc === 0) {
            console.log('MQTT connected');
            pingTimer = setInterval(() => {
              if (socket?.readyState === WebSocket.OPEN) socket.send(PINGREQ);
            }, (KEEPALIVE_SEC - 5) * 1000);
            resolve();
          } else {
            reject(new Error('MQTT CONNACK rejected, code=' + rc));
          }
        } else {
          handleIncomingPacket(packetType, body);
        }
        recvBuffer = recvBuffer.subarray(total);
      }
    };

    socket.onerror = () => reject(new Error('WebSocket failed'));
    socket.onclose = (e) => {
      console.log('MQTT closed, code=', e.code);
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    };

    setTimeout(() => reject(new Error('MQTT connect timeout')), 15000);
  });
}

export function mqttSubscribe(topic, handler) {
  if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('not connected');
  handlers.set(topic, handler);
  socket.send(packSUBSCRIBE(nextPacketId++, topic));
}

export function mqttPublish(topic, payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('not connected');
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  socket.send(packPUBLISH(topic, body));
}

export function mqttDisconnect() {
  if (socket?.readyState === WebSocket.OPEN) {
    try { socket.send(DISCONNECT); } catch {}
    socket.close();
  }
  socket = null;
  handlers.clear();
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
}
