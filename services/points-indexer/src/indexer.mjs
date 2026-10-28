import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { attributeLogs, normalizeLog } from "./attribute.mjs";
import { canonicalJson, compareRows } from "./canonical.mjs";
import { ACTION, CHAIN_ID, DAY_SECONDS, isAcceptedChain } from "./constants.mjs";
import { PointsError, hexInt, isUniqueError, lowerHex } from "./hex.mjs";
import {
  SANCTIONS_INSERT_CHECK,
  SANCTIONS_INSERT_WALLET,
  SANCTIONS_MATCH,
  SANCTIONS_READ_CACHE,
  SANCTIONS_READ_WALLETS,
  SANCTIONS_REFRESH_MS,
  SANCTIONS_SCHEMA_SQL,
  SANCTIONS_WRITE_CACHE,
  SDN_ADVANCED_URL,
  applySanctionsDecision,
  forgetNotedDecision,
  noteDecision,
  refreshParsedList,
  sanctionsCheckLog,
  sanctionsCheckParams,
  screenFromStored,
} from "./sanctions.mjs";
import { evaluateChain, expiryAccepts, linkHash, recoverSigner } from "./signature.mjs";

const RPC_NOT_BEFORE_KEY = "rpc_not_before";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS raw_logs (
  chain_id INTEGER NOT NULL,
  contract TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  block_timestamp INTEGER NOT NULL,
  topics_json TEXT NOT NULL,
  data TEXT NOT NULL,
  removed INTEGER NOT NULL,
  tx_from TEXT,
  PRIMARY KEY (chain_id, contract, tx_hash, log_index)
);
CREATE TABLE IF NOT EXISTS origins (
  actor_id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL,
  identity_anchor INTEGER NOT NULL,
  behavioral_signals INTEGER NOT NULL,
  model_version TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet TEXT NOT NULL,
  action TEXT NOT NULL,
  escrow_id TEXT NOT NULL,
  entries_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS nonces (
  nonce TEXT PRIMARY KEY,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  wallet TEXT NOT NULL,
  block_timestamp INTEGER NOT NULL,
  issue_time INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'confirmed', 'revoked')),
  seq INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS nonces_one_open
  ON nonces (tx_hash, log_index, wallet)
  WHERE status = 'open';
CREATE TABLE IF NOT EXISTS links (
  nonce TEXT PRIMARY KEY,
  escrow_id TEXT NOT NULL,
  action TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  expiry INTEGER NOT NULL,
  wallet TEXT NOT NULL,
  signature TEXT NOT NULL,
  seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger_rows (
  seq INTEGER NOT NULL,
  chain_id INTEGER NOT NULL,
  contract TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  block_timestamp INTEGER NOT NULL,
  utc_day INTEGER NOT NULL,
  wallet TEXT NOT NULL,
  action TEXT NOT NULL,
  escrow_id TEXT NOT NULL,
  points INTEGER NOT NULL,
  eligibility_status TEXT NOT NULL,
  eligibility_reason TEXT NOT NULL,
  points_withheld INTEGER NOT NULL,
  rule_weight INTEGER,
  counts_for_return_day INTEGER NOT NULL,
  register_status TEXT,
  dispute_id TEXT,
  support INTEGER,
  source_action TEXT,
  source_tx_hash TEXT,
  source_log_index INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS ledger_wallet_action_day
  ON ledger_rows (wallet, action, utc_day);
CREATE UNIQUE INDEX IF NOT EXISTS ledger_log_key
  ON ledger_rows (chain_id, contract, tx_hash, log_index)
  WHERE action IN ('fund', 'release_or_refund', 'dispute_open_or_vote');
CREATE UNIQUE INDEX IF NOT EXISTS ledger_first_activity
  ON ledger_rows (wallet)
  WHERE action = 'first_activity';
CREATE UNIQUE INDEX IF NOT EXISTS ledger_return_day
  ON ledger_rows (wallet, utc_day)
  WHERE action = 'return_day';
${SANCTIONS_SCHEMA_SQL.join(";\n")};
`;

function readConfig(name) {
  const url = new URL(`../config/${name}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
}

function normalizeRegister(register) {
  const voters = register?.voters ?? register ?? {};
  const out = {};
  for (const [wallet, kind] of Object.entries(voters)) {
    const address = lowerHex(wallet);
    if (!address || (kind !== "human" && kind !== "ai" && kind !== "pending")) {
      throw new PointsError("bad_register", { wallet });
    }
    out[address] = kind;
  }
  return out;
}

function normalizeWeights(weights) {
  const source = weights?.weights ?? weights ?? {};
  return {
    first_activity: nullableNumber(source.first_activity),
    fund: nullableNumber(source.fund),
    release_or_refund: nullableNumber(source.release_or_refund),
    dispute_open_or_vote: nullableNumber(source.dispute_open_or_vote),
    vote: nullableNumber(source.vote),
    return_day: nullableNumber(source.return_day),
  };
}

function normalizeGates(gates) {
  const source = gates?.gates ?? gates ?? {};
  return {
    same_pair_per_day: nullableNumber(source.same_pair_per_day),
    same_pair_lifetime: nullableNumber(source.same_pair_lifetime),
    min_escrow_amount_wei: source.min_escrow_amount_wei == null ? null : String(source.min_escrow_amount_wei),
    min_escrow_duration_seconds: nullableNumber(source.min_escrow_duration_seconds),
  };
}

function nullableNumber(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isInteger(number)) throw new PointsError("bad_config");
  return number;
}

function newNonce() {
  let value = 0n;
  while (value === 0n) value = BigInt(`0x${randomBytes(32).toString("hex")}`);
  return value.toString();
}

/**
 * Stored RPC deadline, or null when the file has none.
 * A missing file is null. This does not create a database.
 * @param {string} dbPath
 * @returns {number | null}
 */
export function readRpcNotBefore(dbPath) {
  if (dbPath == null || dbPath === ":memory:" || !existsSync(dbPath)) return null;
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(RPC_NOT_BEFORE_KEY);
    if (!row) return null;
    const parsed = Number(row.value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/**
 * Write or clear the stored RPC deadline.
 * A missing file is created when a deadline is stored, so a fresh deploy
 * keeps a startup wait across a restart. Clearing a missing file does nothing.
 * @param {string} dbPath
 * @param {number | null} epochMs
 */
export function writeRpcNotBefore(dbPath, epochMs) {
  if (dbPath == null || dbPath === ":memory:") return;
  if (epochMs != null && !Number.isSafeInteger(epochMs)) return;
  if (!existsSync(dbPath)) {
    if (epochMs == null) return;
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  let db;
  try {
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    if (epochMs == null) {
      db.prepare("DELETE FROM meta WHERE key = ?").run(RPC_NOT_BEFORE_KEY);
      return;
    }
    db.prepare(
      "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(RPC_NOT_BEFORE_KEY, String(epochMs));
  } catch {
    // A foreign file without this table is ignored. The in-memory deadline still applies.
  } finally {
    db?.close();
  }
}

export function openIndexer(options = {}) {
  return new Indexer(options);
}

export class Indexer {
  constructor(options = {}) {
    const chainId = options.chainId ?? CHAIN_ID;
    if (!isAcceptedChain(chainId)) throw new PointsError("wrong_chain", { chainId });
    this.chainId = CHAIN_ID;
    this.db = new DatabaseSync(options.path ?? ":memory:");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(SCHEMA);
    this.lastSkips = [];
    if (!this.#metaGet("configured")) {
      const finalizedBlock = options.finalizedBlock;
      if (!Number.isInteger(finalizedBlock) || finalizedBlock < 0) throw new PointsError("bad_finalized");
      this.#metaSet("finalized_block", String(finalizedBlock));
      this.#metaSet("register", JSON.stringify(normalizeRegister(options.register ?? readConfig("arbitrator-register.json"))));
      this.#metaSet("weights", JSON.stringify(normalizeWeights(options.weights ?? readConfig("points.json"))));
      this.#metaSet("gates", JSON.stringify(normalizeGates(options.gates ?? readConfig("points.json"))));
      this.#metaSet("configured", "1");
    }
    this.#loadConfig();
    this.rebuild();
  }

  close() {
    this.db.close();
  }

  #metaGet(key) {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return row ? row.value : null;
  }

  #metaSet(key, value) {
    this.db.prepare(
      "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(key, value);
  }

  #loadConfig() {
    this.finalizedBlock = Number(this.#metaGet("finalized_block"));
    this.register = JSON.parse(this.#metaGet("register"));
    this.weights = JSON.parse(this.#metaGet("weights"));
    this.gates = JSON.parse(this.#metaGet("gates"));
  }

  /**
   * The finalized head only moves forward. A lower reading is ignored so a
   * rebuild cannot withhold rows that were already committed.
   * Pass `{ rebuild: false }` when the caller will rebuild once for the pass.
   */
  setFinalizedBlock(finalizedBlock, options = {}) {
    if (!Number.isInteger(finalizedBlock) || finalizedBlock < 0) throw new PointsError("bad_finalized");
    const next = Math.max(this.finalizedBlock, finalizedBlock);
    if (next === this.finalizedBlock) return { moved: false, finalizedBlock: this.finalizedBlock };
    this.#metaSet("finalized_block", String(next));
    this.finalizedBlock = next;
    if (options.rebuild !== false) this.rebuild();
    return { moved: true, finalizedBlock: next };
  }

  lastScannedBlock() {
    const raw = this.#metaGet("last_scanned_block");
    if (raw == null || raw === "") return null;
    const parsed = Number(raw);
    return Number.isInteger(parsed) ? parsed : null;
  }

  /**
   * Epoch milliseconds before the next RPC. Null clears the stored deadline.
   * @param {number | null} epochMs
   */
  setRpcNotBefore(epochMs) {
    if (epochMs == null) {
      this.db.prepare("DELETE FROM meta WHERE key = ?").run(RPC_NOT_BEFORE_KEY);
      return;
    }
    if (!Number.isSafeInteger(epochMs)) return;
    this.#metaSet(RPC_NOT_BEFORE_KEY, String(epochMs));
  }

  setRegister(register) {
    const normalized = normalizeRegister(register);
    this.#metaSet("register", JSON.stringify(normalized));
    this.register = normalized;
    this.rebuild();
  }

  setWeights(weights) {
    const normalized = normalizeWeights(weights);
    this.#metaSet("weights", JSON.stringify(normalized));
    this.weights = normalized;
    this.rebuild();
  }

  setGates(gates) {
    const normalized = normalizeGates(gates);
    this.#metaSet("gates", JSON.stringify(normalized));
    this.gates = normalized;
    this.rebuild();
  }

  /**
   * Server-side origin tag. A chain payload cannot set this.
   * identityAnchor and behavioralSignals are required before a human entry can approve.
   */
  setOrigin(actorId, fields) {
    const address = lowerHex(actorId);
    if (!address) throw new PointsError("bad_address");
    const actorType = fields?.actorType;
    if (actorType !== "human" && actorType !== "ai") throw new PointsError("actor_type");
    this.db.prepare(
      `INSERT INTO origins(actor_id, actor_type, identity_anchor, behavioral_signals, model_version)
       VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(actor_id) DO UPDATE SET
         actor_type = excluded.actor_type,
         identity_anchor = excluded.identity_anchor,
         behavioral_signals = excluded.behavioral_signals,
         model_version = excluded.model_version`,
    ).run(
      address,
      actorType,
      fields.identityAnchor ? 1 : 0,
      fields.behavioralSignals ? 1 : 0,
      String(fields.modelVersion ?? ""),
    );
    this.rebuild();
    return { ok: true, actorId: address, actorType };
  }

  rejectClientKey() {
    return { committed: false, reason: "client_key_rejected" };
  }

  /**
   * Store raw logs. observedAt is accepted and ignored: utc_day comes from the block header.
   * A client-supplied tx hash or log index on the side is not read.
   */
  ingestLogs(logs, { chainId = CHAIN_ID, observedAt = null } = {}) {
    if (!isAcceptedChain(chainId)) throw new PointsError("wrong_chain", { chainId });
    void observedAt;
    if (!Array.isArray(logs)) throw new PointsError("unverifiable_log");
    const normalized = logs.map((log) => normalizeLog(log));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let inserted = 0;
      for (const log of normalized) {
        inserted += this.#upsertRaw(log);
      }
      this.db.exec("COMMIT");
      this.rebuild();
      return { ok: true, inserted };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Insert one scanned window and the cursor in a single transaction.
   * A throw before COMMIT rolls both back, so a crash cannot skip the window.
   * This does not rebuild; the pass rebuilds once after the windows.
   */
  commitScanWindow(logs, scannedThrough, { chainId = CHAIN_ID, beforeCommit = null } = {}) {
    if (!isAcceptedChain(chainId)) throw new PointsError("wrong_chain", { chainId });
    if (!Number.isInteger(scannedThrough) || scannedThrough < 0) throw new PointsError("bad_cursor");
    if (!Array.isArray(logs)) throw new PointsError("unverifiable_log");
    const previous = this.lastScannedBlock();
    if (previous != null && scannedThrough < previous) throw new PointsError("cursor_backwards");
    const normalized = logs.map((log) => normalizeLog(log));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let inserted = 0;
      for (const log of normalized) inserted += this.#upsertRaw(log);
      this.#metaSet("last_scanned_block", String(scannedThrough));
      if (beforeCommit) beforeCommit();
      this.db.exec("COMMIT");
      return { ok: true, inserted, scannedThrough };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  #upsertRaw(log) {
    const existing = this.db.prepare(
      "SELECT removed FROM raw_logs WHERE chain_id = ? AND contract = ? AND tx_hash = ? AND log_index = ?",
    ).get(this.chainId, log.contract, log.txHash, log.logIndex);
    if (!existing) {
      this.db.prepare(
        `INSERT INTO raw_logs(
           chain_id, contract, tx_hash, log_index, block_number, block_hash, block_timestamp,
           topics_json, data, removed, tx_from
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        this.chainId,
        log.contract,
        log.txHash,
        log.logIndex,
        log.blockNumber,
        log.blockHash,
        log.blockTimestamp,
        JSON.stringify(log.topics),
        log.data,
        log.removed ? 1 : 0,
        log.txFrom,
      );
      return 1;
    }
    if (existing.removed === 1 && !log.removed) {
      this.db.prepare(
        `UPDATE raw_logs
         SET block_number = ?, block_hash = ?, block_timestamp = ?, topics_json = ?, data = ?, removed = 0, tx_from = ?
         WHERE chain_id = ? AND contract = ? AND tx_hash = ? AND log_index = ?`,
      ).run(
        log.blockNumber,
        log.blockHash,
        log.blockTimestamp,
        JSON.stringify(log.topics),
        log.data,
        log.txFrom,
        this.chainId,
        log.contract,
        log.txHash,
        log.logIndex,
      );
      return 1;
    }
    return 0;
  }

  rawCount() {
    return this.db.prepare("SELECT COUNT(*) AS n FROM raw_logs").get().n;
  }

  submitChain({ wallet, action, escrowId, entries }) {
    const address = lowerHex(wallet);
    const escrow = lowerHex(escrowId);
    if (!address || !escrow || !action || !Array.isArray(entries)) {
      const stored = this.#storeChain(address || wallet, action, escrow || escrowId, entries || [], "bad_chain");
      return stored;
    }
    const copied = entries.map(copyEntry);
    const verdict = evaluateChain(copied, this.#origins(), null);
    this.#storeChain(address, String(action), escrow, copied, verdict.reason);
    this.rebuild();
    return { stored: true, accepted: verdict.accepted, reason: verdict.reason };
  }

  #storeChain(wallet, action, escrowId, entries, reason) {
    this.db.prepare(
      "INSERT INTO chains(wallet, action, escrow_id, entries_json) VALUES(?, ?, ?, ?)",
    ).run(String(wallet || ""), String(action || ""), String(escrowId || ""), JSON.stringify(entries));
    return { stored: true, accepted: false, reason: reason || "bad_chain" };
  }

  issueNonce({ txHash, logIndex, wallet, issueTime }) {
    const hash = lowerHex(txHash);
    const address = lowerHex(wallet);
    let index;
    try {
      index = hexInt(logIndex);
    } catch {
      return { ok: false, reason: "bad_log_index", stored: false };
    }
    if (!hash || !address || !Number.isInteger(issueTime)) {
      return { ok: false, reason: "bad_nonce_request", stored: false };
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const raw = this.db.prepare(
        "SELECT removed, block_timestamp FROM raw_logs WHERE chain_id = ? AND tx_hash = ? AND log_index = ?",
      ).get(this.chainId, hash, index);
      if (!raw) {
        this.db.exec("ROLLBACK");
        return { ok: false, reason: "log_unknown", stored: false };
      }
      if (raw.removed === 1) {
        this.db.exec("ROLLBACK");
        return { ok: false, reason: "removed", stored: false };
      }
      const candidate = this.#candidateFor(hash, index, address, true);
      if (!candidate) {
        this.db.exec("ROLLBACK");
        return { ok: false, reason: "wallet_mismatch", stored: false };
      }
      if (issueTime > candidate.blockTimestamp + DAY_SECONDS) {
        this.db.exec("ROLLBACK");
        return { ok: false, reason: "issue_window", stored: false };
      }
      const open = this.db.prepare(
        "SELECT nonce FROM nonces WHERE tx_hash = ? AND log_index = ? AND wallet = ? AND status = 'open'",
      ).get(hash, index, address);
      if (open) {
        this.db.exec("ROLLBACK");
        return { ok: false, reason: "nonce_open", stored: false };
      }
      const nonce = newNonce();
      const seq = this.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM nonces").get().seq;
      this.db.prepare(
        `INSERT INTO nonces(nonce, tx_hash, log_index, wallet, block_timestamp, issue_time, status, seq)
         VALUES(?, ?, ?, ?, ?, ?, 'open', ?)`,
      ).run(nonce, hash, index, address, candidate.blockTimestamp, issueTime, seq);
      this.db.exec("COMMIT");
      return { ok: true, nonce, txHash: hash, logIndex: index, wallet: address, issueTime, stored: true };
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // already closed
      }
      if (isUniqueError(error)) return { ok: false, reason: "nonce_open", stored: false };
      throw error;
    }
  }

  revokeNonce(nonce) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT status FROM nonces WHERE nonce = ?").get(String(nonce));
      if (!row) {
        this.db.exec("ROLLBACK");
        return { ok: false, reason: "nonce_unknown" };
      }
      if (row.status !== "open") {
        this.db.exec("ROLLBACK");
        return { ok: false, reason: "nonce_consumed" };
      }
      this.db.prepare("UPDATE nonces SET status = 'revoked' WHERE nonce = ? AND status = 'open'").run(String(nonce));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.rebuild();
    return { ok: true, reason: "revoked" };
  }

  submitLink(body) {
    const parsed = parseLinkBody(body);
    if (!parsed.ok) return { ok: false, committed: false, reason: parsed.reason, stored: false };
    const hash = linkHash(parsed.link);
    if (typeof hash !== "string") {
      return { ok: false, committed: false, reason: hash?.reason || "bad_link", stored: false };
    }
    const recovered = recoverSigner(hash, parsed.link.signature);
    if (!recovered.ok) return { ok: false, committed: false, reason: recovered.reason, stored: false };
    if (recovered.address !== parsed.link.wallet) {
      return { ok: false, committed: false, reason: "signer_mismatch", stored: false };
    }
    const nonce = this.getNonce(parsed.link.nonce);
    if (!nonce) return { ok: false, committed: false, reason: "nonce_unknown", stored: false };
    if (nonce.status !== "open") return { ok: false, committed: false, reason: "nonce_consumed", stored: false };
    if (nonce.tx_hash !== parsed.link.txHash || nonce.log_index !== parsed.link.logIndex || nonce.wallet !== parsed.link.wallet) {
      return { ok: false, committed: false, reason: "binding_mismatch", stored: false };
    }
    const existing = this.db.prepare("SELECT nonce FROM links WHERE nonce = ?").get(parsed.link.nonce);
    if (existing) return { ok: false, committed: this.#hasLogRow(parsed.link), reason: "duplicate_link", stored: false };
    const candidate = this.#candidateFor(parsed.link.txHash, parsed.link.logIndex, parsed.link.wallet, true);
    if (!candidate) return { ok: false, committed: false, reason: "wallet_mismatch", stored: false };
    if (candidate.action !== parsed.link.action || candidate.escrowId !== parsed.link.escrowId) {
      return { ok: false, committed: false, reason: "link_fields", stored: false };
    }
    if (!expiryAccepts(candidate.blockTimestamp, parsed.link.expiry)) {
      return { ok: false, committed: false, reason: "expiry", stored: false };
    }
    const seq = this.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM links").get().seq;
    this.db.prepare(
      `INSERT INTO links(nonce, escrow_id, action, tx_hash, log_index, expiry, wallet, signature, seq)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      parsed.link.nonce,
      parsed.link.escrowId,
      parsed.link.action,
      parsed.link.txHash,
      parsed.link.logIndex,
      parsed.link.expiry,
      parsed.link.wallet,
      parsed.link.signature,
      seq,
    );
    this.rebuild();
    const confirmed = this.getNonce(parsed.link.nonce)?.status === "confirmed";
    const committed = this.#hasLogRow(parsed.link);
    return {
      ok: confirmed && committed,
      committed,
      reason: confirmed ? "confirmed" : (committed ? "duplicate_log" : this.#skipReason(parsed.link) || "not_confirmed"),
      stored: true,
    };
  }

  getNonce(nonce) {
    return this.db.prepare("SELECT * FROM nonces WHERE nonce = ?").get(String(nonce)) ?? null;
  }

  nonceCount() {
    return this.db.prepare("SELECT COUNT(*) AS n FROM nonces").get().n;
  }

  listChains() {
    return this.db.prepare("SELECT id, wallet, action, escrow_id, entries_json FROM chains ORDER BY id").all().map((row) => ({
      id: row.id,
      wallet: row.wallet,
      action: row.action,
      escrowId: row.escrow_id,
      entries: JSON.parse(row.entries_json),
    }));
  }

  ledger() {
    return this.db.prepare("SELECT * FROM ledger_rows ORDER BY seq").all();
  }

  canonical() {
    return canonicalJson([...this.ledger()].sort(compareRows));
  }

  attribute() {
    return attributeLogs(this.#rawObjects(), {
      finalizedBlock: this.finalizedBlock,
      chainId: this.chainId,
    });
  }

  #ensureSanctionsTables() {
    for (const statement of SANCTIONS_SCHEMA_SQL) this.db.exec(statement);
  }

  #loadSanctionsScreen(now = Date.now()) {
    try {
      this.#ensureSanctionsTables();
      const cache = this.db.prepare(SANCTIONS_READ_CACHE).get() ?? null;
      const wallets = this.db.prepare(SANCTIONS_READ_WALLETS).all();
      return screenFromStored(cache, wallets, now);
    } catch {
      return screenFromStored(null, [], now);
    }
  }

  #writeSanctionsCheck(screen, wallet, decision) {
    const params = sanctionsCheckParams(screen, wallet, decision);
    this.db.prepare(SANCTIONS_INSERT_CHECK).run(
      params.wallet,
      params.result,
      params.reason,
      params.checkedAt,
      params.listVersion,
      params.source,
      params.persisted,
    );
    if (params.storeWallet) {
      this.db.prepare(SANCTIONS_INSERT_WALLET).run(
        params.wallet,
        SANCTIONS_MATCH,
        params.checkedAt,
        params.listVersion,
      );
    }
    console.info(JSON.stringify(sanctionsCheckLog(screen, wallet, decision)));
  }

  async refreshSanctions(options = {}) {
    const fetchImpl = options.fetch;
    if (typeof fetchImpl !== "function") return { refreshed: false, failed: true, listVersion: null };
    const now = options.now ?? Date.now();
    const refreshMs = options.refreshMs ?? SANCTIONS_REFRESH_MS;
    const source = options.source ?? SDN_ADVANCED_URL;
    let cache = null;
    try {
      this.#ensureSanctionsTables();
      cache = this.db.prepare(SANCTIONS_READ_CACHE).get() ?? null;
    } catch {
      console.error(JSON.stringify({ message: "sanctions_refresh_failed" }));
      return { refreshed: false, failed: true, listVersion: null };
    }
    const outcome = await refreshParsedList(fetchImpl, source, now, refreshMs, cache, {
      minAddresses: options.minAddresses,
      timeoutMs: options.timeoutMs,
      byteCap: options.byteCap,
    });
    if (outcome.failed) {
      console.error(JSON.stringify({ message: "sanctions_refresh_failed" }));
      return { refreshed: false, failed: true, listVersion: outcome.listVersion };
    }
    if (outcome.addressesJson != null) {
      this.db.prepare(SANCTIONS_WRITE_CACHE).run(outcome.fetchedAt, source, outcome.listVersion, outcome.addressesJson);
    }
    return {
      refreshed: outcome.refreshed,
      failed: false,
      listVersion: outcome.listVersion,
      count: outcome.count,
    };
  }

  rebuild() {
    const logs = this.#rawObjects();
    const attribution = attributeLogs(logs, {
      finalizedBlock: this.finalizedBlock,
      chainId: this.chainId,
      includeUnfinalized: false,
    });
    const origins = this.#origins();
    const chains = this.listChains();
    const nonces = new Map(
      this.db.prepare("SELECT * FROM nonces").all().map((row) => {
        if (row.status === "confirmed") row.status = "open";
        return [row.nonce, row];
      }),
    );
    const links = this.db.prepare("SELECT * FROM links ORDER BY seq").all().map((row) => ({
      nonce: row.nonce,
      escrowId: row.escrow_id,
      action: row.action,
      txHash: row.tx_hash,
      logIndex: row.log_index,
      expiry: row.expiry,
      wallet: row.wallet,
      signature: row.signature,
      seq: row.seq,
    }));

    const skips = [];
    for (const item of attribution.skipped) skips.push(item);
    for (const item of attribution.withheld) skips.push(item);
    for (const item of attribution.deferred) skips.push({ reason: item.reason, txHash: item.txHash, logIndex: item.logIndex });

    const firstDay = new Map();
    const returnDays = new Set();
    const pairDay = new Map();
    const pairLife = new Map();

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const screen = this.#loadSanctionsScreen();
      this.db.exec("DELETE FROM ledger_rows");
      const insert = this.db.prepare(
        `INSERT INTO ledger_rows(
           seq, chain_id, contract, tx_hash, log_index, block_number, block_timestamp, utc_day,
           wallet, action, escrow_id, points, eligibility_status, eligibility_reason, points_withheld,
           rule_weight, counts_for_return_day, register_status, dispute_id, support,
           source_action, source_tx_hash, source_log_index
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      let seq = 0;
      const daySlot = new Set();
      const logSlot = new Set();
      const tryInsert = (row) => {
        const dayKey = `${row.wallet}|${row.action}|${row.utc_day}`;
        const logKey = `${row.chain_id}|${row.contract}|${row.tx_hash}|${row.log_index}`;
        if (daySlot.has(dayKey)) return false;
        if ((row.action === ACTION.fund || row.action === ACTION.releaseOrRefund || row.action === ACTION.disputeOpenOrVote) && logSlot.has(logKey)) {
          return false;
        }
        if (row.action === ACTION.firstActivity && firstDay.has(row.wallet)) return false;
        if (row.action === ACTION.returnDay && returnDays.has(`${row.wallet}|${row.utc_day}`)) return false;
        const noted = noteDecision(screen, row.wallet);
        applySanctionsDecision(row, noted.decision);
        try {
          this.db.exec("SAVEPOINT row");
          seq += 1;
          insert.run(
            seq,
            row.chain_id,
            row.contract,
            row.tx_hash,
            row.log_index,
            row.block_number,
            row.block_timestamp,
            row.utc_day,
            row.wallet,
            row.action,
            row.escrow_id,
            row.points,
            row.eligibility_status,
            row.eligibility_reason,
            row.points_withheld,
            row.rule_weight,
            row.counts_for_return_day,
            row.register_status,
            row.dispute_id,
            row.support,
            row.source_action,
            row.source_tx_hash,
            row.source_log_index,
          );
          if (noted.first) this.#writeSanctionsCheck(screen, row.wallet, noted.decision);
          this.db.exec("RELEASE row");
          daySlot.add(dayKey);
          if (row.action === ACTION.fund || row.action === ACTION.releaseOrRefund || row.action === ACTION.disputeOpenOrVote) {
            logSlot.add(logKey);
          }
          return true;
        } catch (error) {
          this.db.exec("ROLLBACK TO row");
          this.db.exec("RELEASE row");
          seq -= 1;
          if (noted.first) forgetNotedDecision(screen, row.wallet, noted.decision);
          if (!isUniqueError(error)) throw error;
          return false;
        }
      };

      for (const candidate of attribution.candidates) {
        if (!candidate.finalized) {
          skips.push({ reason: "not_finalized", txHash: candidate.txHash, logIndex: candidate.logIndex });
          continue;
        }
        const chain = this.#chainFor(candidate, chains, origins);
        if (!chain.accepted) {
          skips.push({ reason: chain.reason, txHash: candidate.txHash, logIndex: candidate.logIndex, wallet: candidate.wallet });
          continue;
        }
        const link = this.#linkFor(candidate, links, nonces);
        if (!link.ok) {
          skips.push({ reason: link.reason, txHash: candidate.txHash, logIndex: candidate.logIndex, wallet: candidate.wallet });
          continue;
        }
        const gate = gateReason(candidate, this.gates, pairDay, pairLife);
        if (gate) {
          skips.push({ reason: gate, txHash: candidate.txHash, logIndex: candidate.logIndex, wallet: candidate.wallet });
          continue;
        }
        const vote = voteFields(candidate, this.register, this.weights);
        const inserted = tryInsert(rowFrom(candidate, {
          action: candidate.action,
          ruleWeight: vote.ruleWeight,
          countsForReturnDay: vote.countsForReturnDay ? 1 : 0,
          registerStatus: vote.registerStatus,
          sourceAction: null,
        }));
        if (!inserted) {
          skips.push({ reason: "duplicate_log", txHash: candidate.txHash, logIndex: candidate.logIndex, wallet: candidate.wallet, action: candidate.action });
          continue;
        }
        nonces.get(link.nonce).status = "confirmed";
        if (candidate.role !== "vote" && candidate.pair) {
          bump(pairDay, `${candidate.wallet}|${candidate.pair}|${candidate.utcDay}`);
          bump(pairLife, `${candidate.wallet}|${candidate.pair}`);
        }
        if (candidate.role !== "vote" && !firstDay.has(candidate.wallet)) {
          const derived = tryInsert(rowFrom(candidate, {
            action: ACTION.firstActivity,
            ruleWeight: this.weights.first_activity,
            countsForReturnDay: 0,
            registerStatus: null,
            sourceAction: candidate.action,
          }));
          if (derived) firstDay.set(candidate.wallet, candidate.utcDay);
        }
        const day = firstDay.get(candidate.wallet);
        if (vote.countsForReturnDay && day !== undefined && candidate.utcDay > day && !returnDays.has(`${candidate.wallet}|${candidate.utcDay}`)) {
          const derived = tryInsert(rowFrom(candidate, {
            action: ACTION.returnDay,
            ruleWeight: this.weights.return_day,
            countsForReturnDay: 0,
            registerStatus: null,
            sourceAction: candidate.action,
          }));
          if (derived) returnDays.add(`${candidate.wallet}|${candidate.utcDay}`);
        }
      }
      settleNonceStatuses(this.db, nonces);
      // Renumber seq in canonical order after cap conflicts drop rows.
      const rows = this.db.prepare("SELECT rowid, * FROM ledger_rows").all().sort(compareRows);
      const renumber = this.db.prepare("UPDATE ledger_rows SET seq = ? WHERE rowid = ?");
      rows.forEach((row, index) => renumber.run(index + 1, row.rowid));
      this.db.exec("COMMIT");
      this.lastSkips = skips;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // no transaction
      }
      throw error;
    }
  }

  #candidateFor(txHash, logIndex, wallet, includeUnfinalized) {
    const attribution = attributeLogs(this.#rawObjects(), {
      finalizedBlock: this.finalizedBlock,
      chainId: this.chainId,
      includeUnfinalized,
    });
    return attribution.candidates.find((candidate) =>
      candidate.txHash === txHash && candidate.logIndex === logIndex && candidate.wallet === wallet) ?? null;
  }

  #rawObjects() {
    return this.db.prepare("SELECT * FROM raw_logs").all().map((row) => ({
      address: row.contract,
      transactionHash: row.tx_hash,
      blockHash: row.block_hash,
      blockNumber: row.block_number,
      logIndex: row.log_index,
      blockTimestamp: row.block_timestamp,
      topics: JSON.parse(row.topics_json),
      data: row.data,
      removed: row.removed === 1,
      transactionFrom: row.tx_from,
    }));
  }

  #origins() {
    const map = new Map();
    for (const row of this.db.prepare("SELECT * FROM origins").all()) {
      map.set(row.actor_id, {
        actorType: row.actor_type,
        identityAnchor: row.identity_anchor === 1,
        behavioralSignals: row.behavioral_signals === 1,
        modelVersion: row.model_version,
      });
    }
    return map;
  }

  #chainFor(candidate, chains, origins) {
    const latest = chains
      .filter((chain) => chain.wallet === candidate.wallet && chain.action === candidate.action && chain.escrowId === candidate.escrowId)
      .sort((a, b) => b.id - a.id)[0];
    if (!latest) return { accepted: false, reason: "missing_chain" };
    const verdict = evaluateChain(latest.entries, origins, candidate.blockTimestamp);
    if (verdict.accepted && verdict.terminalWallet !== candidate.wallet) {
      return { accepted: false, reason: "terminal_wallet", maxTimestamp: verdict.maxTimestamp };
    }
    return verdict;
  }

  #linkFor(candidate, links, nonces) {
    const matches = links
      .filter((link) =>
        link.txHash === candidate.txHash
        && link.logIndex === candidate.logIndex
        && link.wallet === candidate.wallet
        && link.action === candidate.action
        && link.escrowId === candidate.escrowId)
      .sort((a, b) => a.seq - b.seq);
    let reason = "missing_link";
    for (const link of matches) {
      const nonce = nonces.get(link.nonce);
      if (!nonce || nonce.status === "revoked") {
        reason = "nonce_consumed";
        continue;
      }
      if (nonce.status === "confirmed") {
        reason = "duplicate_log";
        continue;
      }
      if (nonce.tx_hash !== candidate.txHash || nonce.log_index !== candidate.logIndex || nonce.wallet !== candidate.wallet) {
        reason = "binding_mismatch";
        continue;
      }
      if (!expiryAccepts(candidate.blockTimestamp, link.expiry)) {
        reason = "expiry";
        continue;
      }
      const digest = linkHash(link);
      if (typeof digest !== "string") {
        reason = digest?.reason || "bad_link";
        continue;
      }
      const recovered = recoverSigner(digest, link.signature);
      if (!recovered.ok) {
        reason = recovered.reason;
        continue;
      }
      if (recovered.address !== candidate.wallet) {
        reason = "signer_mismatch";
        continue;
      }
      return { ok: true, nonce: link.nonce };
    }
    return { ok: false, reason };
  }

  #hasLogRow(link) {
    const row = this.db.prepare(
      `SELECT 1 AS ok FROM ledger_rows
       WHERE chain_id = ? AND contract IS NOT NULL AND tx_hash = ? AND log_index = ? AND wallet = ?
         AND action IN ('fund', 'release_or_refund', 'dispute_open_or_vote')`,
    ).get(this.chainId, link.txHash, link.logIndex, link.wallet);
    return Boolean(row);
  }

  #skipReason(link) {
    return this.lastSkips.find((skip) => skip.txHash === link.txHash && skip.logIndex === link.logIndex)?.reason ?? null;
  }
}

function copyEntry(entry) {
  return {
    actorId: String(entry.actorId),
    actorType: String(entry.actorType),
    modelVersion: String(entry.modelVersion ?? ""),
    timestamp: Number(entry.timestamp),
    scope: String(entry.scope ?? ""),
    authority: String(entry.authority),
    accountableHumanId: String(entry.accountableHumanId || "0x0000000000000000000000000000000000000000"),
    signature: String(entry.signature || ""),
  };
}

function parseLinkBody(body) {
  if (!body || typeof body !== "object") return { ok: false, reason: "bad_link" };
  const txHash = lowerHex(body.txHash);
  const escrowId = lowerHex(body.escrowId);
  const wallet = lowerHex(body.wallet);
  if (!txHash || !/^0x[0-9a-f]{64}$/.test(txHash)) return { ok: false, reason: "bad_link" };
  if (!escrowId || !/^0x[0-9a-f]{64}$/.test(escrowId)) return { ok: false, reason: "bad_link" };
  if (!wallet || !/^0x[0-9a-f]{40}$/.test(wallet)) return { ok: false, reason: "bad_link" };
  let logIndex;
  let expiry;
  try {
    logIndex = hexInt(body.logIndex);
    expiry = hexInt(body.expiry);
  } catch {
    return { ok: false, reason: "bad_link" };
  }
  if (body.nonce === undefined || body.nonce === null || body.nonce === "") {
    return { ok: false, reason: "nonce_unknown" };
  }
  return {
    ok: true,
    link: {
      nonce: String(body.nonce),
      escrowId,
      action: String(body.action),
      txHash,
      logIndex,
      expiry,
      wallet,
      signature: String(body.signature ?? ""),
    },
  };
}

function settleNonceStatuses(db, nonces) {
  const openByKey = new Map();
  for (const row of nonces.values()) {
    if (row.status !== "open") continue;
    const key = `${row.tx_hash}|${row.log_index}|${row.wallet}`;
    const current = openByKey.get(key);
    if (!current || row.seq > current.seq) {
      if (current) current.status = "revoked";
      openByKey.set(key, row);
    } else {
      row.status = "revoked";
    }
  }
  const update = db.prepare("UPDATE nonces SET status = ? WHERE nonce = ?");
  for (const row of nonces.values()) update.run(row.status, row.nonce);
}

function bump(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function gateReason(candidate, gates, pairDay, pairLife) {
  if (candidate.role === "vote") return null;
  if (gates.min_escrow_amount_wei != null) {
    if (candidate.amount == null || BigInt(candidate.amount) < BigInt(gates.min_escrow_amount_wei)) return "min_escrow_amount";
  }
  if (gates.min_escrow_duration_seconds != null) {
    if (candidate.createTimestamp == null || candidate.expiresAt == null) return "min_escrow_duration";
    if (candidate.expiresAt - candidate.createTimestamp < gates.min_escrow_duration_seconds) return "min_escrow_duration";
  }
  if (candidate.pair && gates.same_pair_per_day != null) {
    const used = pairDay.get(`${candidate.wallet}|${candidate.pair}|${candidate.utcDay}`) || 0;
    if (used >= gates.same_pair_per_day) return "same_pair_day";
  }
  if (candidate.pair && gates.same_pair_lifetime != null) {
    const used = pairLife.get(`${candidate.wallet}|${candidate.pair}`) || 0;
    if (used >= gates.same_pair_lifetime) return "same_pair_lifetime";
  }
  return null;
}

function voteFields(candidate, register, weights) {
  if (candidate.role === "vote") {
    const registerStatus = register[candidate.wallet] ?? "pending";
    const configured = weights.vote;
    const registeredHuman = registerStatus === "human";
    const weightSet = configured != null && configured > 0;
    const countsForReturnDay = registeredHuman && weightSet;
    return {
      registerStatus,
      ruleWeight: registeredHuman ? configured : null,
      countsForReturnDay,
    };
  }
  return {
    registerStatus: null,
    ruleWeight: weights[candidate.action] ?? null,
    countsForReturnDay: true,
  };
}

function rowFrom(candidate, fields) {
  return {
    chain_id: candidate.chainId,
    contract: candidate.contract,
    tx_hash: candidate.txHash,
    log_index: candidate.logIndex,
    block_number: candidate.blockNumber,
    block_timestamp: candidate.blockTimestamp,
    utc_day: candidate.utcDay,
    wallet: candidate.wallet,
    action: fields.action,
    escrow_id: candidate.escrowId,
    points: 0,
    eligibility_status: "unverified",
    eligibility_reason: "ofac_unconfigured",
    points_withheld: 1,
    rule_weight: fields.ruleWeight,
    counts_for_return_day: fields.countsForReturnDay,
    register_status: fields.registerStatus,
    dispute_id: candidate.disputeId,
    support: candidate.support,
    source_action: fields.sourceAction,
    source_tx_hash: fields.sourceAction ? candidate.txHash : null,
    source_log_index: fields.sourceAction ? candidate.logIndex : null,
  };
}
