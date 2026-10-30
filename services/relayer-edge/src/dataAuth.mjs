// HMAC for POST /internal/sanctions/<op>. The secret is RELAYER_DATA_AUTH.
// Do not log the secret, the signature, the body, or a wallet.

const encoder = new TextEncoder();

export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_SWAP_BODY_BYTES = 96 * 1024;
export const SKEW_MS = 60_000;

// Same minimum as the origin: at least 32 bytes of hex, and an even length.
const DATA_AUTH_SECRET = /^[0-9a-fA-F]{64,}$/;

export function dataSecret(env) {
  const value = env && env.RELAYER_DATA_AUTH;
  if (typeof value !== "string") return "";
  const secret = value.trim();
  if (!DATA_AUTH_SECRET.test(secret) || secret.length % 2 !== 0) return "";
  return secret;
}

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return hex(new Uint8Array(digest));
}

export function hex(bytes) {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function hexToBytes(value) {
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function nonceBytes(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return 0;
  return Math.floor((value.length * 3) / 4);
}

export function canonicalMessage(method, path, ts, nonce, bodyHash) {
  return `${method}\n${path}\n${ts}\n${nonce}\n${bodyHash}`;
}

async function hmacMatches(secret, message, sigHex) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, hexToBytes(sigHex), encoder.encode(message));
}

/**
 * Reads the body once. Returns { ok:false, status, error } or the verified fields.
 * Query strings are refused. A missing or bad header, a skew over 60s, or a bad
 * signature is 401. The caller checks the secret before this runs.
 */
export async function verifyDataAuth(request, secret, pathname, now, maxBytes) {
  const url = new URL(request.url);
  if (url.search) return { ok: false, status: 401, error: "unauthorized" };
  const ts = request.headers.get("x-relayer-ts");
  const nonce = request.headers.get("x-relayer-nonce");
  const sig = request.headers.get("x-relayer-data-sig");
  if (!ts || !nonce || !sig) return { ok: false, status: 401, error: "unauthorized" };
  if (!/^[0-9]{1,16}$/.test(ts)) return { ok: false, status: 401, error: "unauthorized" };
  const tsNum = Number(ts);
  if (!Number.isSafeInteger(tsNum)) return { ok: false, status: 401, error: "unauthorized" };
  if (Math.abs(now - tsNum) > SKEW_MS) return { ok: false, status: 401, error: "unauthorized" };
  if (nonceBytes(nonce) < 16) return { ok: false, status: 401, error: "unauthorized" };
  if (!/^[0-9a-fA-F]{64}$/.test(sig)) return { ok: false, status: 401, error: "unauthorized" };
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, status: 400, error: "bad_request" };
  const bodyBytes = new Uint8Array(await request.arrayBuffer());
  if (bodyBytes.byteLength > maxBytes) return { ok: false, status: 400, error: "bad_request" };
  const bodyHash = await sha256Hex(bodyBytes);
  const message = canonicalMessage(request.method.toUpperCase(), pathname, ts, nonce, bodyHash);
  let match = false;
  try {
    match = await hmacMatches(secret, message, sig);
  } catch {
    match = false;
  }
  if (!match) return { ok: false, status: 401, error: "unauthorized" };
  return { ok: true, nonce, now, bodyBytes };
}
