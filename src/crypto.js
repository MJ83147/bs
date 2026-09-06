const enc = new TextEncoder();
const dec = new TextDecoder();

function b64ToBytes(b64) {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}
function bytesToB64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}
export function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

async function aesKey(secret) {
  const raw = b64ToBytes(secret);
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encrypt(secret, plaintext) {
  const key = await aesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext)));
  return bytesToB64(iv) + '.' + bytesToB64(ct);
}

export async function decrypt(secret, blob) {
  const [ivB64, ctB64] = blob.split('.');
  const key = await aesKey(secret);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(ivB64) }, key, b64ToBytes(ctB64));
  return dec.decode(pt);
}

export async function hmac(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  return bytesToB64(sig);
}

export async function verifyDiscord(publicKeyHex, signatureHex, timestamp, body) {
  const key = await crypto.subtle.importKey('raw', hexToBytes(publicKeyHex), { name: 'Ed25519' }, false, ['verify']);
  return crypto.subtle.verify('Ed25519', key, hexToBytes(signatureHex), enc.encode(timestamp + body));
}
