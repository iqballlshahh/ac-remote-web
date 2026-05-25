// Cognito Identity + SigV4 + MQTT 3.1.1 over WebSocket + DynamoDB queries.
// Pure browser, no external libraries.

const cfg = window.APP_CONFIG;

let creds = null;
let identityId = null;
const COGNITO_ENDPOINT = `https://cognito-identity.${cfg.AWS_REGION}.amazonaws.com/`;
const KEEPALIVE_SEC = 60;

// ============================================================
// COGNITO
// ============================================================
async function cognitoCall(target, body) {
  const resp = await fetch(COGNITO_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': `AWSCognitoIdentityService.${target}` },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) {
    let msg = text;
    try { const j = JSON.parse(text); msg = `${j.__type || 'Error'}: ${j.message || j.Message || text}`; } catch {}
    throw new Error(`Cognito ${target} failed (${resp.status}): ${msg}`);
  }
  return JSON.parse(text);
}

export async function signInWithGoogle(idToken) {
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
  };
  return { identityId, creds };
}

export function getIdentityId() { return identityId; }
export function getCreds()      { return creds; }

// ============================================================
// SIGV4 — building blocks
// ============================================================
async function hmac(keyData, msg) {
  const key = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)));
}
async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const toHex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');

async function signingKey(dateStamp, region, service) {
  const k1 = await hmac(new TextEncoder().encode('AWS4' + creds.secretAccessKey), dateStamp);
  const k2 = await hmac(k1, region);
  const k3 = await hmac(k2, service);
  return await hmac(k3, 'aws4_request');
}

// ============================================================
// SIGV4 — IoT WebSocket URL signing
// ============================================================
export async function signIotWebSocketUrl() {
  const region = cfg.AWS_REGION, host = cfg.IOT_ENDPOINT;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:\-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const credScope = `${dateStamp}/${region}/iotdevicegateway/aws4_request`;
  const qp = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${creds.accessKeyId}/${credScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': '86400',
    'X-Amz-SignedHeaders': 'host',
  };
  const cq = Object.keys(qp).sort().map(k => `${encodeURIComponent(k)}=${encodeURIComponent(qp[k])}`).join('&');
  const cr = ['GET', '/mqtt', cq, `host:${host}\n`, 'host', await sha256Hex('')].join('\n');
  const sts = ['AWS4-HMAC-SHA256', amzDate, credScope, await sha256Hex(cr)].join('\n');
  const sig = toHex(await hmac(await signingKey(dateStamp, region, 'iotdevicegateway'), sts));

  let url = `wss://${host}/mqtt?${cq}&X-Amz-Signature=${sig}`;
  if (creds.sessionToken) url += `&X-Amz-Security-Token=${encodeURIComponent(creds.sessionToken)}`;
  return url;
}

// ============================================================
// SIGV4 — POST request signing (for DynamoDB)
// ============================================================
async function signedPostHeaders(host, target, body) {
  const region = cfg.AWS_REGION;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:\-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const credScope = `${dateStamp}/${region}/dynamodb/aws4_request`;
  const payloadHash = await sha256Hex(body);

  // Canonical headers must be in alphabetical order, lowercase
  const headersForSigning = {
    'content-type': 'application/x-amz-json-1.0',
    'host': host,
    'x-amz-date': amzDate,
    'x-amz-target': target,
  };
  if (creds.sessionToken) headersForSigning['x-amz-security-token'] = creds.sessionToken;

  const sortedNames = Object.keys(headersForSigning).sort();
  const canonicalHeaders = sortedNames.map(n => `${n}:${headersForSigning[n]}\n`).join('');
  const signedHeaders = sortedNames.join(';');

  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credScope, await sha256Hex(canonicalRequest)].join('\n');
  const signature = toHex(await hmac(await signingKey(dateStamp, region, 'dynamodb'), stringToSign));

  return {
    'Content-Type': 'application/x-amz-json-1.0',
    'X-Amz-Date': amzDate,
    'X-Amz-Target': target,
    ...(creds.sessionToken ? { 'X-Amz-Security-Token': creds.sessionToken } : {}),
    'Authorization': `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

// ============================================================
// DYNAMODB
// ============================================================
export async function dynamoQuery(tableName, partitionKeyName, partitionKeyValue) {
  const host = `dynamodb.${cfg.AWS_REGION}.amazonaws.com`;
  const target = 'DynamoDB_20120810.Query';
  const body = JSON.stringify({
    TableName: tableName,
    KeyConditionExpression: '#pk = :pkv',
    ExpressionAttributeNames: { '#pk': partitionKeyName },
    ExpressionAttributeValues: { ':pkv': { S: partitionKeyValue } },
  });
  const headers = await signedPostHeaders(host, target, body);
  const resp = await fetch(`https://${host}/`, { method: 'POST', headers, body });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`DynamoDB Query failed (${resp.status}): ${text}`);
  const parsed = JSON.parse(text);
  return (parsed.Items || []).map(dynamoToPlain);
}

export async function dynamoDelete(tableName, partitionKeyName, partitionKeyValue, sortKeyName, sortKeyValue) {
  const host = `dynamodb.${cfg.AWS_REGION}.amazonaws.com`;
  const target = 'DynamoDB_20120810.DeleteItem';
  const body = JSON.stringify({
    TableName: tableName,
    Key: {
      [partitionKeyName]: { S: partitionKeyValue },
      [sortKeyName]: { S: sortKeyValue },
    },
  });
  const headers = await signedPostHeaders(host, target, body);
  const resp = await fetch(`https://${host}/`, { method: 'POST', headers, body });
  if (!resp.ok) throw new Error(`DynamoDB DeleteItem failed (${resp.status}): ${await resp.text()}`);
}

// Put a full item. `item` is a plain JS object; we convert to DynamoDB attribute-value form.
export async function dynamoPut(tableName, item) {
  const host = `dynamodb.${cfg.AWS_REGION}.amazonaws.com`;
  const target = 'DynamoDB_20120810.PutItem';
  const body = JSON.stringify({ TableName: tableName, Item: plainToDynamo(item) });
  const headers = await signedPostHeaders(host, target, body);
  const resp = await fetch(`https://${host}/`, { method: 'POST', headers, body });
  if (!resp.ok) throw new Error(`DynamoDB PutItem failed (${resp.status}): ${await resp.text()}`);
}

// Update specific attributes of an item. `updates` is `{ attrName: newValue, ... }`.
export async function dynamoUpdate(tableName, partitionKeyName, partitionKeyValue, sortKeyName, sortKeyValue, updates) {
  const host = `dynamodb.${cfg.AWS_REGION}.amazonaws.com`;
  const target = 'DynamoDB_20120810.UpdateItem';
  const names = {}, values = {}, sets = [];
  let i = 0;
  for (const [k, v] of Object.entries(updates)) {
    const an = `#a${i}`, av = `:v${i}`;
    names[an] = k;
    values[av] = plainToDynamoValue(v);
    sets.push(`${an} = ${av}`);
    i++;
  }
  const body = JSON.stringify({
    TableName: tableName,
    Key: {
      [partitionKeyName]: { S: partitionKeyValue },
      [sortKeyName]: { S: sortKeyValue },
    },
    UpdateExpression: 'SET ' + sets.join(', '),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  });
  const headers = await signedPostHeaders(host, target, body);
  const resp = await fetch(`https://${host}/`, { method: 'POST', headers, body });
  if (!resp.ok) throw new Error(`DynamoDB UpdateItem failed (${resp.status}): ${await resp.text()}`);
}

function plainToDynamoValue(v) {
  if (v === null || v === undefined) return { NULL: true };
  if (typeof v === 'string')  return { S: v };
  if (typeof v === 'number')  return { N: String(v) };
  if (typeof v === 'boolean') return { BOOL: v };
  if (Array.isArray(v))       return { L: v.map(plainToDynamoValue) };
  if (typeof v === 'object') {
    const m = {};
    for (const [k, sub] of Object.entries(v)) m[k] = plainToDynamoValue(sub);
    return { M: m };
  }
  return { S: String(v) };
}
function plainToDynamo(item) {
  const out = {};
  for (const [k, v] of Object.entries(item)) out[k] = plainToDynamoValue(v);
  return out;
}

// Convert a DynamoDB item ({ "name": { "S": "Foo" }, "power": { "BOOL": true } })
// to a plain JS object ({ "name": "Foo", "power": true })
function dynamoToPlain(item) {
  const out = {};
  for (const k of Object.keys(item)) {
    const v = item[k];
    if (v.S !== undefined) out[k] = v.S;
    else if (v.N !== undefined) out[k] = Number(v.N);
    else if (v.BOOL !== undefined) out[k] = v.BOOL;
    else if (v.NULL !== undefined) out[k] = null;
    else if (v.M !== undefined) {
      const sub = {};
      for (const sk of Object.keys(v.M)) sub[sk] = dynamoToPlain({ x: v.M[sk] }).x;
      out[k] = sub;
    }
    else if (v.L !== undefined) out[k] = v.L.map(x => dynamoToPlain({ x }).x);
    else out[k] = v;
  }
  return out;
}

// ============================================================
// MQTT 3.1.1 wire protocol (unchanged from before)
// ============================================================
function concat(...arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}
function encVarLen(n) {
  const b = [];
  do { let x = n & 0x7F; n >>>= 7; if (n > 0) x |= 0x80; b.push(x); } while (n > 0);
  return new Uint8Array(b);
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
  return { str: new TextDecoder().decode(data.subarray(off + 2, off + 2 + len)), bytesRead: 2 + len };
}

// MQTT 5.0 packet builders (we proved AWS IoT requires 5.0 on the WSS endpoint)
function packCONNECT(clientId) {
  const varHdr = concat(
    encStr('MQTT'),
    new Uint8Array([0x05, 0x02, (KEEPALIVE_SEC >> 8) & 0xff, KEEPALIVE_SEC & 0xff, 0x00]),
  );
  const payload = encStr(clientId);
  const remaining = varHdr.length + payload.length;
  return concat(new Uint8Array([0x10]), encVarLen(remaining), varHdr, payload);
}
function packSUBSCRIBE(packetId, topic) {
  const pid = new Uint8Array([(packetId >> 8) & 0xff, packetId & 0xff]);
  const props = new Uint8Array([0x00]);
  const subOpts = new Uint8Array([0x00]);
  const payload = concat(encStr(topic), subOpts);
  const remaining = pid.length + props.length + payload.length;
  return concat(new Uint8Array([0x82]), encVarLen(remaining), pid, props, payload);
}
function packPUBLISH(topic, body) {
  const topicBytes = encStr(topic);
  const props = new Uint8Array([0x00]);
  const payloadBytes = new TextEncoder().encode(body);
  const remaining = topicBytes.length + props.length + payloadBytes.length;
  return concat(new Uint8Array([0x30]), encVarLen(remaining), topicBytes, props, payloadBytes);
}
const PINGREQ    = new Uint8Array([0xC0, 0x00]);
const DISCONNECT = new Uint8Array([0xE0, 0x00]);

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
  if (packetType === 0x30) {
    const ts = decStr(body, 0);
    let off = ts.bytesRead;
    const props = decVarLen(body, off);
    if (props) off += props.bytesRead + props.length;
    const payload = new TextDecoder().decode(body.subarray(off));
    let json = null;
    try { json = JSON.parse(payload); } catch {}
    for (const [pattern, handler] of handlers) {
      if (topicMatches(pattern, ts.str)) handler(ts.str, json ?? payload);
    }
  }
}

export async function mqttConnect() {
  const url = await signIotWebSocketUrl();
  const clientId = 'web-' + Math.random().toString(36).slice(2, 10);
  return new Promise((resolve, reject) => {
    socket = new WebSocket(url, ['mqtt']);
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
        if (packetType === 0x20) {
          const reasonCode = body[1];
          if (reasonCode === 0) {
            console.log('MQTT 5 connected');
            pingTimer = setInterval(() => {
              if (socket?.readyState === WebSocket.OPEN) socket.send(PINGREQ);
            }, (KEEPALIVE_SEC - 5) * 1000);
            resolve();
          } else reject(new Error(`MQTT CONNACK reason=${reasonCode}`));
        } else handleIncomingPacket(packetType, body);
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
