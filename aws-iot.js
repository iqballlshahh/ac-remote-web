// Cognito Identity + SigV4 + MQTT — pure browser, no SDK, no polyfills.
// We call the two Cognito Identity endpoints we need (GetId, GetCredentialsForIdentity)
// directly over fetch. Both are unauthenticated — the caller's Google ID token is the
// credential. Then we sign the MQTT-over-WSS URL with SigV4 using Web Crypto API.

const cfg = window.APP_CONFIG;

let creds = null;            // { accessKeyId, secretAccessKey, sessionToken, expiration }
let identityId = null;       // Cognito identity ID — used as user_id everywhere
let googleIdToken = null;

const COGNITO_ENDPOINT = `https://cognito-identity.${cfg.AWS_REGION}.amazonaws.com/`;

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
  const region   = cfg.AWS_REGION;
  const host     = cfg.IOT_ENDPOINT;
  const service  = 'iotdevicegateway';
  const method   = 'GET';
  const path     = '/mqtt';

  const now = new Date();
  const amzDate    = now.toISOString().replace(/[:\-]|\.\d{3}/g, '');
  const dateStamp  = amzDate.slice(0, 8);
  const credScope  = `${dateStamp}/${region}/${service}/aws4_request`;

  const queryParams = {
    'X-Amz-Algorithm':     'AWS4-HMAC-SHA256',
    'X-Amz-Credential':    `${creds.accessKeyId}/${credScope}`,
    'X-Amz-Date':          amzDate,
    'X-Amz-Expires':       '86400',
    'X-Amz-SignedHeaders': 'host',
  };
  const canonicalQuery = Object.keys(queryParams).sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(queryParams[k])}`)
    .join('&');

  const canonicalHeaders = `host:${host}\n`;
  const signedHeaders    = 'host';
  const payloadHash      = await sha256Hex('');

  const canonicalRequest = [
    method, path, canonicalQuery,
    canonicalHeaders, signedHeaders, payloadHash,
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate, credScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate    = await hmac(new TextEncoder().encode('AWS4' + creds.secretAccessKey), dateStamp);
  const kRegion  = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, 'aws4_request');
  const sig      = toHex(await hmac(kSigning, stringToSign));

  let url = `wss://${host}${path}?${canonicalQuery}&X-Amz-Signature=${sig}`;
  if (creds.sessionToken) {
    url += `&X-Amz-Security-Token=${encodeURIComponent(creds.sessionToken)}`;
  }
  return url;
}

// ============================================================
// MQTT client — wraps mqtt.js (loaded globally from CDN)
// ============================================================
let client = null;
const handlers = new Map();

export async function mqttConnect() {
  const url = await signIotWebSocketUrl();
  return new Promise((resolve, reject) => {
    client = window.mqtt.connect(url, {
      protocol: 'wss',
      reconnectPeriod: 4000,
      keepalive: 60,
      clientId: 'web-' + Math.random().toString(36).slice(2, 10),
    });
    client.on('connect', () => resolve(client));
    client.on('error',   reject);
    client.on('message', (topic, payload) => {
      const text = payload.toString();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      for (const [pattern, handler] of handlers) {
        if (topicMatches(pattern, topic)) handler(topic, json ?? text);
      }
    });
  });
}

function topicMatches(pattern, topic) {
  const pp = pattern.split('/');
  const tp = topic.split('/');
  for (let i = 0; i < pp.length; i++) {
    if (pp[i] === '#') return true;
    if (pp[i] === '+') continue;
    if (pp[i] !== tp[i]) return false;
  }
  return pp.length === tp.length;
}

export function mqttSubscribe(topic, handler) {
  if (!client) throw new Error('not connected');
  handlers.set(topic, handler);
  client.subscribe(topic, { qos: 0 });
}

export function mqttPublish(topic, payload) {
  if (!client) throw new Error('not connected');
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  client.publish(topic, body, { qos: 0 });
}

export function mqttDisconnect() {
  if (client) { client.end(true); client = null; handlers.clear(); }
}
