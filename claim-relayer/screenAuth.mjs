// EIP-4361 proof that the caller holds the wallet key. The relayer imports this.
// The points Worker does not.

import { verifyMessage } from "viem";
import { parseSiweMessage, validateSiweMessage } from "viem/siwe";
import { sha256Utf8 } from "./sha256.mjs";

export const SCREEN_SIWE_DOMAIN = "agent-bv.pages.dev";
export const SCREEN_CHAIN_ID = 84532;
export const SCREEN_MAX_AGE_MS = 10 * 60 * 1000;
export const SCREEN_SESSION_MS = 12 * 60 * 60 * 1000;
export const SCREEN_ACTIONS = new Set(["signup", "link", "change", "unlink"]);

const ACCOUNT_ID = /^[A-Za-z0-9._:-]{1,80}$/;
const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function randomNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let out = "";
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return out;
}

function tokenText() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("base64url");
}

export function issueScreenNonce(sql, now) {
  const expiresAt = now + SCREEN_MAX_AGE_MS;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const nonce = randomNonce();
    try {
      sql.run(
        "INSERT INTO screen_nonces(nonce, expires_at, used_at) VALUES(?, ?, NULL)",
        nonce,
        expiresAt,
      );
      return { nonce, expiresAt };
    } catch {
      // A colliding nonce is retried.
    }
  }
  throw new Error("nonce");
}

export function consumeScreenNonce(sql, nonce, now) {
  const result = sql.run(
    "UPDATE screen_nonces SET used_at = ? WHERE nonce = ? AND used_at IS NULL AND expires_at > ?",
    now,
    String(nonce || ""),
    now,
  );
  return Number(result?.changes || 0) === 1;
}

export function createScreenSession(sql, accountId, walletHash, now) {
  const token = tokenText();
  sql.run(
    "INSERT INTO screen_sessions(token_hash, account_id, wallet_hash, expires_at) VALUES(?, ?, ?, ?)",
    sha256Utf8(token),
    String(accountId),
    String(walletHash),
    now + SCREEN_SESSION_MS,
  );
  return token;
}

export function readScreenSession(sql, token, now) {
  if (!token) return null;
  const row = sql.get(
    "SELECT account_id, wallet_hash, expires_at FROM screen_sessions WHERE token_hash = ?",
    sha256Utf8(String(token)),
  );
  if (!row || Number(row.expires_at) <= now) return null;
  return { accountId: String(row.account_id), walletHash: String(row.wallet_hash) };
}

function screenRequest(parsed, action) {
  const request = String(parsed?.requestId || "");
  const split = request.indexOf(":");
  if (split < 1) return null;
  const requestAction = request.slice(0, split);
  const accountId = request.slice(split + 1);
  if (requestAction !== action || !ACCOUNT_ID.test(accountId)) return null;
  return accountId;
}

/**
 * The account id and the wallet come from the signed message.
 * Link, change, and unlink also require the signup session for that account.
 * A matching nonce is consumed only after the signature checks.
 */
export async function verifyScreenProof(sql, input) {
  const action = String(input?.action || "");
  const now = Number(input?.now);
  const domain = String(input?.domain || "");
  const chainId = Number(input?.chainId);
  const message = String(input?.message || "");
  const signature = String(input?.signature || "");
  if (!SCREEN_ACTIONS.has(action) || !domain || !Number.isFinite(now)) return { ok: false };
  let parsed;
  try {
    parsed = parseSiweMessage(message);
  } catch {
    return { ok: false };
  }
  const accountId = screenRequest(parsed, action);
  const wallet = String(parsed?.address || "").toLowerCase();
  if (!accountId || !/^0x[0-9a-f]{40}$/.test(wallet)) return { ok: false };
  if (parsed.chainId !== chainId) return { ok: false };
  if (parsed.uri !== `https://${domain}/v1/screen/${action}`) return { ok: false };
  if (!parsed.expirationTime || !parsed.issuedAt) return { ok: false };
  const issued = parsed.issuedAt.getTime();
  const expires = parsed.expirationTime.getTime();
  if (!Number.isFinite(issued) || !Number.isFinite(expires)) return { ok: false };
  if (expires <= issued || expires - issued > SCREEN_MAX_AGE_MS) return { ok: false };
  if (now < issued - 60_000) return { ok: false };
  if (!validateSiweMessage({
    message: parsed,
    domain,
    nonce: parsed.nonce,
    time: new Date(now),
  })) return { ok: false };
  let signatureOk = false;
  try {
    signatureOk = await verifyMessage({ address: parsed.address, message, signature });
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) return { ok: false };
  if (action !== "signup") {
    const session = readScreenSession(sql, input?.sessionToken, now);
    if (!session || session.accountId !== accountId) return { ok: false };
  }
  if (!consumeScreenNonce(sql, parsed.nonce, now)) return { ok: false };
  return { ok: true, accountId, wallet };
}
