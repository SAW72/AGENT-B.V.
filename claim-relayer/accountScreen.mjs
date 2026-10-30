// Account signup, wallet link, and wallet change. The server decides.
// A clear result stays unverified. It is not an approval.
// Full wallet addresses are sealed here and stored in the open only in sanctions_wallets.
// The node:sqlite helpers in this file stay for the points indexer.
// The relayer gate does not call them. It uses the edge data client.
// A second module that imported this file back would cycle, so the split stops at that comment.

import {
  PUBLIC_DENIAL_MESSAGE,
  SANCTIONS_INSERT_CHECK,
  SANCTIONS_INSERT_WALLET,
  SANCTIONS_MATCH,
  SANCTIONS_UNAVAILABLE,
  decideSanctions,
  normalizeSanctionsAddress,
  sanctionsCheckLog,
  sanctionsCheckParams,
  screenFromStored,
  walletHashHex,
  SANCTIONS_READ_CACHE,
  SANCTIONS_READ_WALLETS,
} from "./sanctions.mjs";
import { SANCTIONS_CLEAR_RETENTION_MS, SANCTIONS_MATCH_RETENTION_MS } from "./sanctions.mjs";
import { walletAesKey } from "./sha256.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function unavailable() {
  return { result: "unavailable", reason: SANCTIONS_UNAVAILABLE, persisted: false };
}

function deny(decision) {
  return {
    ok: false,
    status: decision?.result === "match" ? "ineligible" : "unverified",
    http: 403,
    message: PUBLIC_DENIAL_MESSAGE,
    decision: decision || unavailable(),
  };
}

function allowUnverified(decision) {
  return { ok: true, status: "unverified", http: 200, message: null, decision };
}

export function guardDecision(screen, wallet) {
  try {
    return decideSanctions(wallet, screen || { addresses: new Set(), persisted: new Set(), listReady: false });
  } catch {
    return unavailable();
  }
}

function bytesToB64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function b64ToBytes(value) {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function sealAad(accountId, walletHash) {
  const account = encoder.encode(String(accountId || ""));
  const hash = encoder.encode(String(walletHash || ""));
  const out = new Uint8Array(8 + account.length + hash.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, account.length);
  view.setUint32(4, hash.length);
  out.set(account, 8);
  out.set(hash, 8 + account.length);
  return out;
}

async function aesKey(pepper) {
  const raw = walletAesKey(pepper);
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function sealWallet(pepper, wallet, binding) {
  if (typeof pepper !== "string" || pepper.length === 0) throw new Error("pepper_missing");
  const accountId = String(binding?.accountId || "");
  const walletHash = String(binding?.walletHash || "");
  if (!accountId || !walletHash) throw new Error("seal_binding");
  const key = await aesKey(pepper);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: sealAad(accountId, walletHash) },
      key,
      encoder.encode(wallet),
    ),
  );
  return `${bytesToB64(iv)}.${bytesToB64(cipher)}`;
}

export async function openWallet(pepper, sealed, binding) {
  const parts = String(sealed || "").split(".");
  if (parts.length !== 2) throw new Error("sealed_wallet");
  const key = await aesKey(pepper);
  const plain = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: b64ToBytes(parts[0]),
      additionalData: sealAad(binding?.accountId, binding?.walletHash),
    },
    key,
    b64ToBytes(parts[1]),
  );
  return decoder.decode(plain);
}

export function nodeSql(db) {
  return {
    exec(sql) {
      db.exec(sql);
    },
    get(sql, ...params) {
      return db.prepare(sql).get(...params) ?? null;
    },
    all(sql, ...params) {
      return db.prepare(sql).all(...params);
    },
    run(statement, ...params) {
      return db.prepare(statement).run(...params);
    },
  };
}

export function doSql(sql) {
  return {
    exec(statement) {
      sql.exec(statement);
    },
    get(statement, ...params) {
      return sql.exec(statement, ...params).toArray()[0] ?? null;
    },
    all(statement, ...params) {
      return sql.exec(statement, ...params).toArray();
    },
    run(statement, ...params) {
      sql.exec(statement, ...params);
    },
  };
}

function writeCheck(sql, screen, wallet, decision, input) {
  const params = sanctionsCheckParams(screen, wallet, decision, {
    pepper: input.pepper,
    chainId: input.chainId ?? 84532,
    decisionPoint: input.decisionPoint ?? "screen",
  });
  sql.run(
    SANCTIONS_INSERT_CHECK,
    params.walletHash,
    params.result,
    params.reason,
    params.checkedAt,
    params.listVersion,
    params.listSha256,
    params.source,
    params.persisted,
    params.chainId,
    params.decisionPoint,
  );
  console.info(JSON.stringify(sanctionsCheckLog(screen, wallet, decision, { pepper: input.pepper })));
  return params;
}

function rememberMatch(sql, screen, wallet, input) {
  const normalized = normalizeSanctionsAddress(wallet);
  if (!normalized) return;
  const hash = walletHashHex(input.pepper, normalized) || "pepper_missing";
  sql.run(
    SANCTIONS_INSERT_WALLET,
    normalized,
    hash,
    SANCTIONS_MATCH,
    screen.checkedAt ?? input.now ?? Date.now(),
    screen.listVersion ?? null,
  );
}

async function rememberLink(sql, input, wallet) {
  const normalized = normalizeSanctionsAddress(wallet);
  if (!normalized) throw new Error("wallet");
  const hash = walletHashHex(input.pepper, normalized);
  if (!hash) throw new Error("pepper_missing");
  const sealed = await sealWallet(input.pepper, normalized, { accountId: input.accountId, walletHash: hash });
  const now = input.now ?? Date.now();
  sql.run(
    `INSERT INTO sanctions_account_wallets(account_id, wallet_hash, wallet_sealed, linked_at, unlinked_at)
     VALUES(?, ?, ?, ?, NULL)
     ON CONFLICT(account_id, wallet_hash) DO UPDATE SET
       wallet_sealed = excluded.wallet_sealed,
       unlinked_at = NULL`,
    String(input.accountId),
    hash,
    sealed,
    now,
  );
}

export function accountHasMatch(sql, accountId) {
  const row = sql.get(
    `SELECT 1 AS hit
     FROM sanctions_account_wallets link
     JOIN sanctions_wallets match ON match.wallet_hash = link.wallet_hash
     WHERE link.account_id = ?
     LIMIT 1`,
    String(accountId),
  );
  if (row) return true;
  const blocked = sql.get(
    "SELECT 1 AS hit FROM sanctions_blocks WHERE account_id = ? LIMIT 1",
    String(accountId),
  );
  return Boolean(blocked);
}

export function walletBlockedByAccount(sql, pepper, wallet) {
  const normalized = normalizeSanctionsAddress(wallet);
  const hash = walletHashHex(pepper, normalized);
  if (!hash) return false;
  const direct = sql.get("SELECT 1 AS hit FROM sanctions_wallets WHERE wallet = ? LIMIT 1", normalized);
  if (direct) return true;
  const linked = sql.get(
    `SELECT 1 AS hit
     FROM sanctions_account_wallets me
     JOIN sanctions_account_wallets sibling ON sibling.account_id = me.account_id
     JOIN sanctions_wallets match ON match.wallet_hash = sibling.wallet_hash
     WHERE me.wallet_hash = ?
     LIMIT 1`,
    hash,
  );
  if (linked) return true;
  const blocked = sql.get(
    `SELECT 1 AS hit
     FROM sanctions_account_wallets me
     JOIN sanctions_blocks block ON block.account_id = me.account_id
     WHERE me.wallet_hash = ?
     LIMIT 1`,
    hash,
  );
  return Boolean(blocked);
}

function requireAccount(input) {
  const accountId = String(input?.accountId || "").trim();
  if (!/^[A-Za-z0-9._:-]{1,80}$/.test(accountId)) throw new Error("account");
  return accountId;
}

function requireProven(input) {
  if (input?.proven !== true) {
    const error = new Error("unproven");
    error.code = "unproven";
    throw error;
  }
}

function refused(error) {
  if (error && error.code === "unproven") return { ok: false, http: 401, error: "unproven" };
  return deny(unavailable());
}

export async function signupAccount(sql, screen, input) {
  try {
    requireProven(input);
    const accountId = requireAccount(input);
    const scoped = { ...input, accountId, decisionPoint: "signup" };
    const decision = guardDecision(screen, input.wallet);
    writeCheck(sql, screen, input.wallet, decision, scoped);
    if (decision.result === "match") {
      rememberMatch(sql, screen, input.wallet, scoped);
      const normalized = normalizeSanctionsAddress(input.wallet);
      if (normalized) screen?.persisted?.add(normalized);
    }
    if (decision.result !== "clear") return deny(decision);
    if (accountHasMatch(sql, accountId)) return deny({ result: "match", reason: SANCTIONS_MATCH, persisted: true });
    await rememberLink(sql, scoped, input.wallet);
    return allowUnverified(decision);
  } catch (error) {
    return refused(error);
  }
}

export async function linkWallet(sql, screen, input) {
  try {
    requireProven(input);
    const accountId = requireAccount(input);
    const scoped = { ...input, accountId, decisionPoint: input.decisionPoint || "link" };
    const decision = guardDecision(screen, input.wallet);
    writeCheck(sql, screen, input.wallet, decision, scoped);
    if (decision.result === "match") {
      rememberMatch(sql, screen, input.wallet, scoped);
      const normalized = normalizeSanctionsAddress(input.wallet);
      if (normalized) screen?.persisted?.add(normalized);
      await rememberLink(sql, scoped, input.wallet);
      return deny(decision);
    }
    if (decision.result !== "clear") return deny(decision);
    if (accountHasMatch(sql, accountId)) {
      await rememberLink(sql, scoped, input.wallet);
      return deny({ result: "match", reason: SANCTIONS_MATCH, persisted: true });
    }
    await rememberLink(sql, scoped, input.wallet);
    return allowUnverified(decision);
  } catch (error) {
    return refused(error);
  }
}

export async function changeWallet(sql, screen, input) {
  return linkWallet(sql, screen, { ...input, decisionPoint: "change" });
}

export async function unlinkWallet(sql, screen, input) {
  try {
    requireProven(input);
    const accountId = requireAccount(input);
    const normalized = normalizeSanctionsAddress(input.wallet);
    const hash = walletHashHex(input.pepper, normalized);
    if (!normalized || !hash) return deny(unavailable());
    sql.run(
      `UPDATE sanctions_account_wallets
       SET unlinked_at = ?
       WHERE account_id = ? AND wallet_hash = ?`,
      input.now ?? Date.now(),
      accountId,
      hash,
    );
    if (accountHasMatch(sql, accountId) || walletBlockedByAccount(sql, input.pepper, normalized)) {
      return deny({ result: "match", reason: SANCTIONS_MATCH, persisted: true });
    }
    const decision = guardDecision(screen, normalized);
    if (decision.result !== "clear") return deny(decision);
    return allowUnverified(decision);
  } catch (error) {
    return refused(error);
  }
}

export async function rescreenLinkedWallets(sql, screen, input) {
  const rows = sql.all("SELECT account_id, wallet_hash, wallet_sealed FROM sanctions_account_wallets");
  let checked = 0;
  for (const row of rows) {
    let wallet = "";
    try {
      wallet = await openWallet(input.pepper, row.wallet_sealed, {
        accountId: row.account_id,
        walletHash: row.wallet_hash,
      });
    } catch {
      sql.run(
        `INSERT INTO sanctions_blocks(account_id, wallet_hash, reason, blocked_at) VALUES(?, ?, ?, ?)`,
        String(row.account_id),
        "unreadable",
        SANCTIONS_UNAVAILABLE,
        input.now ?? Date.now(),
      );
      checked += 1;
      continue;
    }
    const decision = guardDecision(screen, wallet);
    writeCheck(sql, screen, wallet, decision, { ...input, accountId: row.account_id, decisionPoint: "refresh" });
    if (decision.result === "match") {
      rememberMatch(sql, screen, wallet, input);
      const normalized = normalizeSanctionsAddress(wallet);
      if (normalized) screen?.persisted?.add(normalized);
    }
    checked += 1;
  }
  return { checked };
}

const RELEASE_AUDIT_SQL =
  `INSERT INTO sanctions_release_audit(wallet_hash, outcome, list_version, released_at, actor) VALUES(?, ?, ?, ?, ?)`;

function releaseActor(value) {
  const actor = String(value || "").trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(actor)) return "";
  return actor;
}

/**
 * False positives only. A wallet still on the ready SDN address set is a confirmed
 * true match and is never removed. The audit insert is append-only.
 */
export function releaseFalsePositive(sql, screen, input) {
  const normalized = normalizeSanctionsAddress(input?.wallet);
  const hash = walletHashHex(input?.pepper, normalized);
  const at = Number.isFinite(input?.now) ? input.now : Date.now();
  const listVersion = screen?.listVersion == null ? null : String(screen.listVersion);
  const actor = releaseActor(input?.actor);
  if (!normalized || !hash) return { ok: false, http: 403, error: "release_refused" };
  const ready = screen?.listReady === true && screen.addresses instanceof Set;
  const listed = ready && screen.addresses.has(normalized);
  if (!ready || listed) {
    sql.run(RELEASE_AUDIT_SQL, hash, listed ? "refused_match" : "refused_unavailable", listVersion, at, actor);
    return { ok: false, http: 403, error: "release_refused" };
  }
  sql.exec("BEGIN IMMEDIATE");
  try {
    sql.run("DELETE FROM sanctions_wallets WHERE wallet = ?", normalized);
    const accounts = sql.all(
      "SELECT DISTINCT account_id FROM sanctions_account_wallets WHERE wallet_hash = ?",
      hash,
    );
    for (const row of accounts) {
      const still = sql.get(
        `SELECT 1 AS hit
         FROM sanctions_account_wallets link
         JOIN sanctions_wallets match ON match.wallet_hash = link.wallet_hash
         WHERE link.account_id = ?
         LIMIT 1`,
        String(row.account_id),
      );
      if (!still) sql.run("DELETE FROM sanctions_blocks WHERE account_id = ?", String(row.account_id));
    }
    sql.run(RELEASE_AUDIT_SQL, hash, "released", listVersion, at, actor);
    sql.exec("COMMIT");
  } catch (error) {
    try {
      sql.exec("ROLLBACK");
    } catch {
      // The transaction is already closed.
    }
    throw error;
  }
  if (screen.persisted instanceof Set) screen.persisted.delete(normalized);
  if (screen.memo instanceof Map) screen.memo.delete(normalized);
  return { ok: true, http: 200 };
}

const TIE_AUDIT_SQL =
  `INSERT INTO sanctions_tie_audit(account_id, wallet_hash, outcome, acted_at, actor) VALUES(?, ?, ?, ?, ?)`;

/**
 * Admin removal of one account-wallet tie. The audit insert is append-only.
 * A direct sanctions_wallets match is left in place.
 */
export function dropAccountTie(sql, screen, input) {
  const actor = releaseActor(input?.actor);
  const at = Number.isFinite(input?.now) ? input.now : Date.now();
  let accountId = "";
  try {
    accountId = requireAccount(input);
  } catch {
    accountId = "";
  }
  const normalized = normalizeSanctionsAddress(input?.wallet);
  const hash = walletHashHex(input?.pepper, normalized);
  if (!actor || !accountId || !normalized || !hash) {
    return { ok: false, http: 403, error: "untie_refused" };
  }
  const existing = sql.get(
    `SELECT 1 AS hit FROM sanctions_account_wallets
     WHERE account_id = ? AND wallet_hash = ?`,
    accountId,
    hash,
  );
  sql.exec("BEGIN IMMEDIATE");
  try {
    if (!existing) {
      sql.run(TIE_AUDIT_SQL, accountId, hash, "untie_absent", at, actor);
      sql.exec("COMMIT");
      return { ok: false, http: 404, error: "untie_absent" };
    }
    sql.run(
      "DELETE FROM sanctions_account_wallets WHERE account_id = ? AND wallet_hash = ?",
      accountId,
      hash,
    );
    const still = sql.get(
      `SELECT 1 AS hit
       FROM sanctions_account_wallets link
       JOIN sanctions_wallets match ON match.wallet_hash = link.wallet_hash
       WHERE link.account_id = ?
       LIMIT 1`,
      accountId,
    );
    if (!still) sql.run("DELETE FROM sanctions_blocks WHERE account_id = ?", accountId);
    sql.run(TIE_AUDIT_SQL, accountId, hash, "untied", at, actor);
    sql.exec("COMMIT");
  } catch (error) {
    try {
      sql.exec("ROLLBACK");
    } catch {
      // The transaction is already closed.
    }
    throw error;
  }
  if (screen?.memo instanceof Map) screen.memo.delete(normalized);
  return { ok: true, http: 200 };
}

export function purgeRetention(sql, now) {
  const clearBefore = now - SANCTIONS_CLEAR_RETENTION_MS;
  const matchBefore = now - SANCTIONS_MATCH_RETENTION_MS;
  const cleared = countRun(sql, "DELETE FROM sanctions_checks WHERE result = 'clear' AND checked_at < ?", clearBefore);
  const unavailable = countRun(
    sql,
    "DELETE FROM sanctions_checks WHERE result = 'unavailable' AND checked_at < ?",
    clearBefore,
  );
  const matches = countRun(sql, "DELETE FROM sanctions_checks WHERE result = 'match' AND checked_at < ?", matchBefore);
  const blocks = countRun(sql, "DELETE FROM sanctions_blocks WHERE blocked_at < ?", matchBefore);
  const blockWallets = countRun(sql, "DELETE FROM sanctions_wallets WHERE checked_at < ?", matchBefore);
  const disputes = countRun(sql, "DELETE FROM sanctions_disputes WHERE opened_at < ?", matchBefore);
  const counts = {
    cleared,
    unavailable,
    matches,
    blocks: blocks + blockWallets,
    disputes,
  };
  console.info(JSON.stringify({ message: "sanctions_retention", ...counts, at: now }));
  return counts;
}

function countRun(sql, statement, cutoff) {
  const info = sql.run(statement, cutoff);
  if (info && Number.isFinite(Number(info.changes))) return Number(info.changes);
  try {
    const row = sql.get("SELECT changes() AS n");
    return Number(row?.n ?? 0);
  } catch {
    return 0;
  }
}

export function loadSnapshot(sql, now = Date.now()) {
  try {
    const cache = sql.get(SANCTIONS_READ_CACHE);
    const wallets = sql.all(SANCTIONS_READ_WALLETS);
    return screenFromStored(cache, wallets, now);
  } catch {
    return screenFromStored(null, [], now);
  }
}

export { PUBLIC_DENIAL_MESSAGE, SANCTIONS_CLEAR_RETENTION_MS, SANCTIONS_MATCH_RETENTION_MS };
