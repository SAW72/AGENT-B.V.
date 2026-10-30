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
const ACTOR_ID = /^[A-Za-z0-9._-]{1,64}$/;
const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** Drop expired nonce and session rows. Called when one of those rows is written. */
export function purgeExpiredScreenAuth(sql, now) {
  if (!Number.isFinite(now)) return;
  sql.run("DELETE FROM screen_nonces WHERE expires_at <= ?", now);
  sql.run("DELETE FROM screen_sessions WHERE expires_at <= ?", now);
}

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
  purgeExpiredScreenAuth(sql, now);
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
  purgeExpiredScreenAuth(sql, now);
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

function accountHasActiveWallets(sql, accountId) {
  const row = sql.get(
    "SELECT 1 AS hit FROM sanctions_account_wallets WHERE account_id = ? AND unlinked_at IS NULL LIMIT 1",
    String(accountId),
  );
  return Boolean(row);
}

const SESSION_AUDIT_SQL =
  "INSERT INTO sanctions_session_audit(account_id, outcome, acted_at, actor, removed) VALUES(?, ?, ?, ?, ?)";

/**
 * Admin removal of every session for one account. The audit insert is append-only.
 * A miss is recorded. Expired rows are deleted first.
 */
export function revokeAccountSessions(sql, accountId, actor, now) {
  const id = String(accountId || "").trim();
  const actorId = String(actor || "").trim();
  const at = Number.isFinite(now) ? now : Date.now();
  if (!ACTOR_ID.test(actorId) || !ACCOUNT_ID.test(id)) {
    return { ok: false, http: 403, error: "revoke_refused" };
  }
  purgeExpiredScreenAuth(sql, at);
  sql.exec("BEGIN IMMEDIATE");
  try {
    const existing = sql.get("SELECT COUNT(*) AS n FROM screen_sessions WHERE account_id = ?", id);
    const removed = Number(existing?.n || 0);
    if (removed === 0) {
      sql.run(SESSION_AUDIT_SQL, id, "revoke_absent", at, actorId, 0);
      sql.exec("COMMIT");
      return { ok: false, http: 404, error: "revoke_absent" };
    }
    sql.run("DELETE FROM screen_sessions WHERE account_id = ?", id);
    sql.run(SESSION_AUDIT_SQL, id, "revoked", at, actorId, removed);
    sql.exec("COMMIT");
    return { ok: true, http: 200, removed };
  } catch (error) {
    try {
      sql.exec("ROLLBACK");
    } catch {
      // The transaction is already closed.
    }
    throw error;
  }
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
 * Link, change, and unlink require the signup session for that account.
 * Signup on an account that already has wallets requires that session too.
 * A matching nonce is consumed only after the signature checks.
 */
export async function verifyScreenProof(sql, input) {
  const action = String(input?.action || "");
  const now = Number(input?.now);
  if (Number.isFinite(now)) purgeExpiredScreenAuth(sql, now);
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
  if (action !== "signup" || accountHasActiveWallets(sql, accountId)) {
    const session = readScreenSession(sql, input?.sessionToken, now);
    if (!session || session.accountId !== accountId) return { ok: false };
  }
  if (!consumeScreenNonce(sql, parsed.nonce, now)) return { ok: false };
  return { ok: true, accountId, wallet };
}
