// Named D1 operations for the relayer. Callers never send SQL.
// Every op is one SANCTIONS_DB.batch(). The nonce insert is the first write
// in that batch, so a replay rolls the op back.
// Audit tables are insert-only. No op updates or deletes them.
// Do not log the secret, the signature, the body, or a raw wallet.

import { MAX_BODY_BYTES, MAX_SWAP_BODY_BYTES, dataSecret, verifyDataAuth } from "./dataAuth.mjs";

export const MIGRATION_NAME = "0001_sanctions.sql";
// D1 allows 100 KB per statement and 2 MB per row. 80 KB of JSON leaves room
// for the rest of the INSERT, so a larger list is stored as a sha and a count.
export const ADDRESS_JSON_MAX = 80_000;
const NONCE_TTL_MS = 120_000;

const ACCOUNT_ID = /^[A-Za-z0-9._:-]{1,80}$/;
const ACTOR_ID = /^[A-Za-z0-9._-]{1,64}$/;
const WALLET = /^0x[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const SCREEN_NONCE = /^[A-Za-z0-9]{8,64}$/;

const CHECK_INSERT =
  `INSERT INTO sanctions_checks(wallet_hash, result, reason, checked_at, list_version, list_sha256, source, persisted, chain_id, decision_point)
   VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const WALLET_INSERT =
  `INSERT INTO sanctions_wallets(wallet, wallet_hash, reason, checked_at, list_version)
   VALUES(?, ?, ?, ?, ?)
   ON CONFLICT(wallet) DO NOTHING`;
const RELEASE_INSERT =
  `INSERT INTO sanctions_release_audit(wallet_hash, outcome, list_version, released_at, actor)
   VALUES(?, ?, ?, ?, ?)`;
const BLOCKED_WALLET = "SELECT 1 AS hit FROM sanctions_wallets WHERE wallet = ? LIMIT 1";
const BLOCKED_LINK = `SELECT 1 AS hit
  FROM sanctions_account_wallets me
  JOIN sanctions_account_wallets sibling ON sibling.account_id = me.account_id
  JOIN sanctions_wallets match ON match.wallet_hash = sibling.wallet_hash
  WHERE me.wallet_hash = ?
  LIMIT 1`;
const BLOCKED_ACCOUNT = `SELECT 1 AS hit
  FROM sanctions_account_wallets me
  JOIN sanctions_blocks block ON block.account_id = me.account_id
  WHERE me.wallet_hash = ?
  LIMIT 1`;
const ACCOUNT_MATCH = `SELECT 1 AS hit
  FROM sanctions_account_wallets link
  JOIN sanctions_wallets match ON match.wallet_hash = link.wallet_hash
  WHERE link.account_id = ?
  LIMIT 1`;
const ACCOUNT_BLOCK = "SELECT 1 AS hit FROM sanctions_blocks WHERE account_id = ? LIMIT 1";
const LINK_UPSERT = `INSERT INTO sanctions_account_wallets(account_id, wallet_hash, wallet_sealed, linked_at, unlinked_at)
  VALUES(?, ?, ?, ?, NULL)
  ON CONFLICT(account_id, wallet_hash) DO UPDATE SET
    wallet_sealed = excluded.wallet_sealed,
    unlinked_at = NULL`;
const LINK_IF_CLEAR = `INSERT INTO sanctions_account_wallets(account_id, wallet_hash, wallet_sealed, linked_at, unlinked_at)
  SELECT ?, ?, ?, ?, NULL
  WHERE NOT EXISTS (
    SELECT 1 FROM sanctions_account_wallets link
    JOIN sanctions_wallets match ON match.wallet_hash = link.wallet_hash
    WHERE link.account_id = ?
  ) AND NOT EXISTS (
    SELECT 1 FROM sanctions_blocks WHERE account_id = ?
  )
  ON CONFLICT(account_id, wallet_hash) DO UPDATE SET
    wallet_sealed = excluded.wallet_sealed,
    unlinked_at = NULL`;
const PURGE_NONCES = "DELETE FROM screen_nonces WHERE expires_at <= ?";
const PURGE_SESSIONS = "DELETE FROM screen_sessions WHERE expires_at <= ?";

export const OPS = new Set([
  "health",
  "check.record",
  "wallet.blocked",
  "snapshot.load",
  "cache.read",
  "cache.swap",
  "account.signup",
  "account.link",
  "account.change",
  "account.unlink",
  "linked.list",
  "blocks.insert",
  "release",
  "tie.drop",
  "sessions.revoke",
  "nonce.issue",
  "nonce.consume",
  "session.create",
  "session.read",
  "retention.purge",
]);

function bad() {
  return { ok: false };
}

function isInt(value) {
  return Number.isSafeInteger(value);
}

function text(value, max) {
  return typeof value === "string" && value.length <= max;
}

function optionalText(value, max) {
  return value == null || text(value, max);
}

function hashOrLabel(value) {
  return value === "pepper_missing" || value === "unreadable" || (typeof value === "string" && HASH.test(value));
}

function checkRow(check) {
  if (!check || typeof check !== "object") return null;
  if (!hashOrLabel(check.walletHash)) return null;
  if (check.result !== "clear" && check.result !== "match" && check.result !== "unavailable") return null;
  if (!text(check.reason, 80)) return null;
  if (!isInt(check.checkedAt)) return null;
  if (!optionalText(check.listVersion, 80)) return null;
  if (check.listSha256 != null && !(typeof check.listSha256 === "string" && HASH.test(check.listSha256))) return null;
  if (!optionalText(check.source, 300)) return null;
  if (check.persisted !== 0 && check.persisted !== 1) return null;
  if (check.chainId != null && !isInt(check.chainId)) return null;
  if (!optionalText(check.decisionPoint, 32)) return null;
  return [
    check.walletHash,
    check.result,
    check.reason,
    check.checkedAt,
    check.listVersion ?? null,
    check.listSha256 ?? null,
    check.source ?? null,
    check.persisted,
    check.chainId ?? null,
    check.decisionPoint ?? null,
  ];
}

function walletRow(wallet) {
  if (!wallet) return null;
  if (!WALLET.test(wallet.wallet || "")) return null;
  if (!(typeof wallet.walletHash === "string" && HASH.test(wallet.walletHash))) return null;
  if (!text(wallet.reason, 80)) return null;
  if (!isInt(wallet.checkedAt)) return null;
  if (!optionalText(wallet.listVersion, 80)) return null;
  return [wallet.wallet, wallet.walletHash, wallet.reason, wallet.checkedAt, wallet.listVersion ?? null];
}

function linkRow(link) {
  if (!link) return null;
  if (!(typeof link.walletHash === "string" && HASH.test(link.walletHash))) return null;
  if (!text(link.walletSealed, 8000) || !link.walletSealed.includes(".")) return null;
  if (!isInt(link.linkedAt)) return null;
  return link;
}

function blockedSelects(wallet, walletHash) {
  const statements = [];
  if (wallet) statements.push({ sql: BLOCKED_WALLET, params: [wallet] });
  if (walletHash) {
    statements.push({ sql: BLOCKED_LINK, params: [walletHash] });
    statements.push({ sql: BLOCKED_ACCOUNT, params: [walletHash] });
  }
  return statements;
}

function accountBlockedSelects(accountId) {
  return [
    { sql: ACCOUNT_MATCH, params: [accountId] },
    { sql: ACCOUNT_BLOCK, params: [accountId] },
  ];
}

function hit(result) {
  return Boolean(result && Array.isArray(result.results) && result.results.length > 0);
}

export function fitAddressesJson(addressesJson) {
  const json = typeof addressesJson === "string" ? addressesJson : "";
  if (json.length <= ADDRESS_JSON_MAX) return json;
  let count = 0;
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) count = parsed.length;
  } catch {
    count = 0;
  }
  return JSON.stringify({ count, omitted: true });
}

function screenPurge(now) {
  return [
    { sql: PURGE_NONCES, params: [now] },
    { sql: PURGE_SESSIONS, params: [now] },
  ];
}

function checkAndWallet(body, accountId) {
  const params = checkRow(body.check);
  if (!params) return null;
  if (accountId && !ACCOUNT_ID.test(accountId)) return null;
  const statements = [{ sql: CHECK_INSERT, params }];
  const wallet = walletRow(body.wallet);
  if (body.wallet && !wallet) return null;
  if (wallet) statements.push({ sql: WALLET_INSERT, params: wallet });
  return statements;
}

export function buildOp(op, body) {
  if (op === "health") {
    return {
      statements: [{
        sql: "SELECT name FROM d1_migrations WHERE name = ?",
        params: [MIGRATION_NAME],
      }],
      read(results) {
        const row = results[0]?.results?.[0];
        return { applied: Boolean(row), name: row ? String(row.name) : null };
      },
    };
  }
  if (op === "check.record") {
    const params = checkRow(body.check);
    if (!params) return bad();
    const wallet = body.wallet ? String(body.wallet) : "";
    if (wallet && !WALLET.test(wallet)) return bad();
    if (body.storeWallet === true && !wallet) return bad();
    const walletHash = typeof body.walletHash === "string" && HASH.test(body.walletHash) ? body.walletHash : "";
    const statements = [{ sql: CHECK_INSERT, params }];
    if (body.storeWallet === true) {
      const row = walletRow({
        wallet,
        walletHash: walletHash || body.check.walletHash,
        reason: body.check.reason,
        checkedAt: body.check.checkedAt,
        listVersion: body.check.listVersion,
      });
      if (!row) return bad();
      statements.push({ sql: WALLET_INSERT, params: row });
    }
    const selects = blockedSelects(wallet, walletHash);
    const selectAt = statements.length;
    statements.push(...selects);
    return {
      statements,
      read(results) {
        const blocked = results.slice(selectAt).some((result) => hit(result));
        return { blocked };
      },
    };
  }
  if (op === "wallet.blocked") {
    const wallet = typeof body.wallet === "string" ? body.wallet : "";
    if (wallet && !WALLET.test(wallet)) return bad();
    const walletHash = typeof body.walletHash === "string" && HASH.test(body.walletHash) ? body.walletHash : "";
    if (!wallet && !walletHash) {
      return {
        statements: [{ sql: "SELECT 1 AS hit WHERE 1 = 0", params: [] }],
        read() { return { blocked: false }; },
      };
    }
    const statements = blockedSelects(wallet, walletHash);
    return {
      statements,
      read(results) {
        return { blocked: results.some((result) => hit(result)) };
      },
    };
  }
  if (op === "snapshot.load" || op === "cache.read") {
    return {
      statements: [
        {
          sql: "SELECT fetched_at, source, list_version, addresses_json, addresses_sha256, raw_sha256 FROM sanctions_cache WHERE id = 1",
          params: [],
        },
        { sql: "SELECT wallet, wallet_hash FROM sanctions_wallets", params: [] },
      ],
      read(results) {
        return {
          cache: results[0]?.results?.[0] ?? null,
          wallets: results[1]?.results ?? [],
        };
      },
    };
  }
  if (op === "cache.swap") {
    if (!isInt(body.fetchedAt)) return bad();
    if (!optionalText(body.source, 300)) return bad();
    if (!optionalText(body.listVersion, 80)) return bad();
    if (!text(body.addressesJson, MAX_SWAP_BODY_BYTES)) return bad();
    if (!(typeof body.addressesSha256 === "string" && HASH.test(body.addressesSha256))) return bad();
    if (!(typeof body.rawSha256 === "string" && HASH.test(body.rawSha256))) return bad();
    const addressesJson = fitAddressesJson(body.addressesJson);
    return {
      statements: [{
        sql: `INSERT INTO sanctions_cache(id, fetched_at, source, list_version, addresses_json, addresses_sha256, raw_sha256)
          VALUES(1, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            fetched_at = excluded.fetched_at,
            source = excluded.source,
            list_version = excluded.list_version,
            addresses_json = excluded.addresses_json,
            addresses_sha256 = excluded.addresses_sha256,
            raw_sha256 = excluded.raw_sha256`,
        params: [body.fetchedAt, body.source ?? null, body.listVersion ?? null, addressesJson, body.addressesSha256, body.rawSha256],
      }],
      read() {
        return { stored: addressesJson.length === body.addressesJson.length ? "full" : "sha" };
      },
    };
  }
  if (op === "account.signup" || op === "account.link" || op === "account.change") {
    if (!ACCOUNT_ID.test(body.accountId || "")) return bad();
    const statements = checkAndWallet(body, body.accountId);
    if (!statements) return bad();
    const link = body.link ? linkRow(body.link) : null;
    if (body.link && !link) return bad();
    const selectAt = statements.length;
    statements.push(...accountBlockedSelects(body.accountId));
    if (link && op === "account.signup") {
      statements.push({
        sql: LINK_IF_CLEAR,
        params: [body.accountId, link.walletHash, link.walletSealed, link.linkedAt, body.accountId, body.accountId],
      });
    } else if (link) {
      statements.push({
        sql: LINK_UPSERT,
        params: [body.accountId, link.walletHash, link.walletSealed, link.linkedAt],
      });
    }
    return {
      statements,
      read(results) {
        return { blocked: results.slice(selectAt, selectAt + 2).some((result) => hit(result)) };
      },
    };
  }
  if (op === "account.unlink") {
    if (!ACCOUNT_ID.test(body.accountId || "")) return bad();
    if (!(typeof body.walletHash === "string" && HASH.test(body.walletHash))) return bad();
    if (!isInt(body.unlinkedAt)) return bad();
    const wallet = typeof body.wallet === "string" ? body.wallet : "";
    if (wallet && !WALLET.test(wallet)) return bad();
    if (!body.check || body.check.decisionPoint !== "unlink") return bad();
    const checkParams = checkRow(body.check);
    if (!checkParams) return bad();
    const statements = [
      { sql: CHECK_INSERT, params: checkParams },
      {
        sql: `UPDATE sanctions_account_wallets SET unlinked_at = ? WHERE account_id = ? AND wallet_hash = ?`,
        params: [body.unlinkedAt, body.accountId, body.walletHash],
      },
      ...accountBlockedSelects(body.accountId),
      ...blockedSelects(wallet, body.walletHash),
    ];
    return {
      statements,
      read(results) {
        return { blocked: results.slice(2).some((result) => hit(result)) };
      },
    };
  }
  if (op === "linked.list") {
    if (body.accountId != null) {
      if (!ACCOUNT_ID.test(body.accountId)) return bad();
      return {
        statements: [{
          sql: "SELECT 1 AS hit FROM sanctions_account_wallets WHERE account_id = ? LIMIT 1",
          params: [body.accountId],
        }],
        read(results) {
          return { hasWallet: hit(results[0]), rows: [] };
        },
      };
    }
    return {
      statements: [{
        sql: "SELECT account_id, wallet_hash, wallet_sealed FROM sanctions_account_wallets",
        params: [],
      }],
      read(results) {
        return { hasWallet: false, rows: results[0]?.results ?? [] };
      },
    };
  }
  if (op === "blocks.insert") {
    const blocks = Array.isArray(body.blocks) ? body.blocks : [];
    const checks = Array.isArray(body.checks) ? body.checks : [];
    const wallets = Array.isArray(body.wallets) ? body.wallets : [];
    if (blocks.length > 40 || checks.length > 20 || wallets.length > 20) return bad();
    const statements = [];
    for (const check of checks) {
      const params = checkRow(check);
      if (!params) return bad();
      statements.push({ sql: CHECK_INSERT, params });
    }
    for (const wallet of wallets) {
      const params = walletRow(wallet);
      if (!params) return bad();
      statements.push({ sql: WALLET_INSERT, params });
    }
    for (const block of blocks) {
      if (!text(block.accountId, 80)) return bad();
      if (!hashOrLabel(block.walletHash)) return bad();
      if (!text(block.reason, 80)) return bad();
      if (!isInt(block.blockedAt)) return bad();
      statements.push({
        sql: "INSERT INTO sanctions_blocks(account_id, wallet_hash, reason, blocked_at) VALUES(?, ?, ?, ?)",
        params: [block.accountId, block.walletHash, block.reason, block.blockedAt],
      });
    }
    if (statements.length === 0) {
      return { statements: [{ sql: "SELECT 1 AS ok", params: [] }], read() { return { inserted: 0 }; } };
    }
    return { statements, read() { return { inserted: statements.length }; } };
  }
  if (op === "release") {
    if (!hashOrLabel(body.walletHash) || body.walletHash === "pepper_missing") return bad();
    if (!(typeof body.walletHash === "string" && HASH.test(body.walletHash))) return bad();
    if (!isInt(body.at)) return bad();
    if (!optionalText(body.listVersion, 80)) return bad();
    const actor = typeof body.actor === "string" ? body.actor : "";
    if (actor && !ACTOR_ID.test(actor)) return bad();
    const outcome = body.outcome;
    if (outcome === "refused_match" || outcome === "refused_unavailable") {
      return {
        statements: [{
          sql: RELEASE_INSERT,
          params: [body.walletHash, outcome, body.listVersion ?? null, body.at, actor],
        }],
        read() { return { outcome }; },
      };
    }
    if (outcome !== "released") return bad();
    if (!WALLET.test(body.wallet || "")) return bad();
    return {
      statements: [
        { sql: "DELETE FROM sanctions_wallets WHERE wallet = ?", params: [body.wallet] },
        {
          sql: `DELETE FROM sanctions_blocks
            WHERE account_id IN (SELECT account_id FROM sanctions_account_wallets WHERE wallet_hash = ?)
            AND NOT EXISTS (
              SELECT 1 FROM sanctions_account_wallets link
              JOIN sanctions_wallets match ON match.wallet_hash = link.wallet_hash
              WHERE link.account_id = sanctions_blocks.account_id
            )`,
          params: [body.walletHash],
        },
        {
          sql: RELEASE_INSERT,
          params: [body.walletHash, "released", body.listVersion ?? null, body.at, actor],
        },
      ],
      read() { return { outcome: "released" }; },
    };
  }
  if (op === "tie.drop") {
    if (!ACCOUNT_ID.test(body.accountId || "")) return bad();
    if (!(typeof body.walletHash === "string" && HASH.test(body.walletHash))) return bad();
    if (!isInt(body.at)) return bad();
    if (!ACTOR_ID.test(body.actor || "")) return bad();
    return {
      statements: [
        {
          sql: `INSERT INTO sanctions_tie_audit(account_id, wallet_hash, outcome, acted_at, actor)
            SELECT ?, ?, CASE WHEN EXISTS(
              SELECT 1 FROM sanctions_account_wallets WHERE account_id = ? AND wallet_hash = ?
            ) THEN 'untied' ELSE 'untie_absent' END, ?, ?`,
          params: [body.accountId, body.walletHash, body.accountId, body.walletHash, body.at, body.actor],
        },
        { sql: "SELECT outcome FROM sanctions_tie_audit WHERE id = last_insert_rowid()", params: [] },
        {
          sql: "DELETE FROM sanctions_account_wallets WHERE account_id = ? AND wallet_hash = ?",
          params: [body.accountId, body.walletHash],
        },
        {
          sql: `DELETE FROM sanctions_blocks WHERE account_id = ? AND NOT EXISTS (
            SELECT 1 FROM sanctions_account_wallets link
            JOIN sanctions_wallets match ON match.wallet_hash = link.wallet_hash
            WHERE link.account_id = ?
          )`,
          params: [body.accountId, body.accountId],
        },
      ],
      read(results) {
        const outcome = results[1]?.results?.[0]?.outcome || "untie_absent";
        return { outcome };
      },
    };
  }
  if (op === "sessions.revoke") {
    if (!isInt(body.at)) return bad();
    if (body.refused === true) {
      const accountId = String(body.accountId || "").slice(0, 80);
      const actor = String(body.actor || "").slice(0, 64);
      return {
        statements: [{
          sql: "INSERT INTO sanctions_session_audit(account_id, outcome, acted_at, actor, removed) VALUES(?, 'revoke_refused', ?, ?, 0)",
          params: [accountId, body.at, actor],
        }],
        read() { return { outcome: "revoke_refused", removed: 0 }; },
      };
    }
    if (!ACCOUNT_ID.test(body.accountId || "")) return bad();
    if (!ACTOR_ID.test(body.actor || "")) return bad();
    return {
      statements: [
        ...screenPurge(body.at),
        {
          sql: `INSERT INTO sanctions_session_audit(account_id, outcome, acted_at, actor, removed)
            SELECT ?, CASE WHEN COUNT(*) = 0 THEN 'revoke_absent' ELSE 'revoked' END, ?, ?, COUNT(*)
            FROM screen_sessions WHERE account_id = ?`,
          params: [body.accountId, body.at, body.actor, body.accountId],
        },
        { sql: "DELETE FROM screen_sessions WHERE account_id = ?", params: [body.accountId] },
        { sql: "SELECT outcome, removed FROM sanctions_session_audit WHERE id = last_insert_rowid()", params: [] },
      ],
      read(results) {
        const row = results[results.length - 1]?.results?.[0] || {};
        return { outcome: row.outcome || "revoke_absent", removed: Number(row.removed || 0) };
      },
    };
  }
  if (op === "nonce.issue") {
    if (!SCREEN_NONCE.test(body.nonce || "")) return bad();
    if (!isInt(body.expiresAt) || !isInt(body.now)) return bad();
    return {
      statements: [
        ...screenPurge(body.now),
        {
          sql: "INSERT INTO screen_nonces(nonce, expires_at, used_at) VALUES(?, ?, NULL)",
          params: [body.nonce, body.expiresAt],
        },
      ],
      read() { return { nonce: body.nonce, expiresAt: body.expiresAt }; },
    };
  }
  if (op === "nonce.consume") {
    if (!text(body.nonce, 128)) return bad();
    if (!isInt(body.now)) return bad();
    return {
      statements: [
        ...screenPurge(body.now),
        {
          sql: "UPDATE screen_nonces SET used_at = ? WHERE nonce = ? AND used_at IS NULL AND expires_at > ?",
          params: [body.now, body.nonce, body.now],
        },
      ],
      read(results) {
        const changes = Number(results[results.length - 1]?.meta?.changes || 0);
        return { consumed: changes === 1 };
      },
    };
  }
  if (op === "session.create") {
    if (!(typeof body.tokenHash === "string" && HASH.test(body.tokenHash))) return bad();
    if (!ACCOUNT_ID.test(body.accountId || "")) return bad();
    if (!(typeof body.walletHash === "string" && HASH.test(body.walletHash))) return bad();
    if (!isInt(body.expiresAt) || !isInt(body.now)) return bad();
    return {
      statements: [
        ...screenPurge(body.now),
        {
          sql: "INSERT INTO screen_sessions(token_hash, account_id, wallet_hash, expires_at) VALUES(?, ?, ?, ?)",
          params: [body.tokenHash, body.accountId, body.walletHash, body.expiresAt],
        },
      ],
      read() { return { created: true }; },
    };
  }
  if (op === "session.read") {
    if (!isInt(body.now)) return bad();
    const statements = [...screenPurge(body.now)];
    if (body.tokenHash != null) {
      if (!(typeof body.tokenHash === "string" && HASH.test(body.tokenHash))) return bad();
      statements.push({
        sql: "SELECT account_id, wallet_hash, expires_at FROM screen_sessions WHERE token_hash = ?",
        params: [body.tokenHash],
      });
    }
    return {
      statements,
      read(results) {
        if (body.tokenHash == null) return { session: null };
        return { session: results[results.length - 1]?.results?.[0] ?? null };
      },
    };
  }
  if (op === "retention.purge") {
    if (!isInt(body.clearBefore) || !isInt(body.matchBefore)) return bad();
    const statements = [
      { sql: "DELETE FROM sanctions_checks WHERE result = 'clear' AND checked_at < ?", params: [body.clearBefore] },
      { sql: "DELETE FROM sanctions_checks WHERE result = 'unavailable' AND checked_at < ?", params: [body.clearBefore] },
      { sql: "DELETE FROM sanctions_checks WHERE result = 'match' AND checked_at < ?", params: [body.matchBefore] },
      { sql: "DELETE FROM sanctions_blocks WHERE blocked_at < ?", params: [body.matchBefore] },
      { sql: "DELETE FROM sanctions_wallets WHERE checked_at < ?", params: [body.matchBefore] },
      { sql: "DELETE FROM sanctions_disputes WHERE opened_at < ?", params: [body.matchBefore] },
    ];
    return {
      statements,
      read(results) {
        const changes = (index) => Number(results[index]?.meta?.changes || 0);
        const cleared = changes(0);
        const unavailable = changes(1);
        const matches = changes(2);
        const blocks = changes(3) + changes(4);
        return { cleared, unavailable, matches, blocks, disputes: changes(5) };
      },
    };
  }
  return bad();
}

function bind(db, statement) {
  const params = (statement.params || []).map((value) => (value === undefined ? null : value));
  const prepared = db.prepare(statement.sql);
  return params.length ? prepared.bind(...params) : prepared;
}

export async function runBatch(db, statements, nonce) {
  const all = [
    { sql: "DELETE FROM relayer_data_nonces WHERE seen_at < ?", params: [nonce.now - NONCE_TTL_MS] },
    { sql: "INSERT INTO relayer_data_nonces(nonce, seen_at) VALUES(?, ?)", params: [nonce.nonce, nonce.now] },
    ...statements,
  ];
  try {
    const results = await db.batch(all.map((statement) => bind(db, statement)));
    return { results: results.slice(2) };
  } catch (error) {
    const message = String(error && error.message ? error.message : "");
    if (message.includes("relayer_data_nonces")) return { error: "replay", status: 409 };
    if (message.includes("screen_nonces")) return { error: "conflict", status: 409 };
    return { error: "unavailable", status: 500 };
  }
}

function internalJson(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export function opFromPath(pathname) {
  const prefix = "/internal/sanctions/";
  if (!pathname.startsWith(prefix)) return "";
  const rest = pathname.slice(prefix.length);
  if (!rest || rest.includes("/")) return "";
  return rest;
}

export async function handleSanctions(request, env, rawPath, normalizedPath = rawPath, now = Date.now()) {
  try {
    const secret = dataSecret(env);
    if (!secret) return internalJson(503, { ok: false, error: "unavailable" });
    const op = opFromPath(normalizedPath);
    const maxBytes = op === "cache.swap" ? MAX_SWAP_BODY_BYTES : MAX_BODY_BYTES;
    const auth = await verifyDataAuth(request, secret, rawPath, now, maxBytes);
    if (!auth.ok) return internalJson(auth.status, { ok: false, error: auth.error });
    if (!OPS.has(op)) return internalJson(404, { ok: false, error: "not_found" });
    if (!env || !env.SANCTIONS_DB) return internalJson(503, { ok: false, error: "unavailable" });
    let body = {};
    if (auth.bodyBytes.byteLength) {
      try {
        body = JSON.parse(new TextDecoder().decode(auth.bodyBytes));
      } catch {
        return internalJson(400, { ok: false, error: "bad_request" });
      }
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return internalJson(400, { ok: false, error: "bad_request" });
    }
    const built = buildOp(op, body);
    if (!built.ok && !built.statements) return internalJson(400, { ok: false, error: "bad_request" });
    const outcome = await runBatch(env.SANCTIONS_DB, built.statements, { nonce: auth.nonce, now: auth.now });
    if (outcome.error) return internalJson(outcome.status, { ok: false, error: outcome.error });
    return internalJson(200, { ok: true, result: built.read(outcome.results) });
  } catch {
    return internalJson(500, { ok: false, error: "unavailable" });
  }
}
