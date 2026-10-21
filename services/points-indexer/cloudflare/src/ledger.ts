import pointsConfig from "../../config/points.json";
import registerConfig from "../../config/arbitrator-register.json";
import chainsConfig from "../../config/chains.json";
import linksConfig from "../../config/links.json";
import { attributeLogs, normalizeLog } from "../../src/attribute.mjs";
import { compareRows } from "../../src/canonical.mjs";
import { ACTION, CHAIN_ID, isAcceptedChain } from "../../src/constants.mjs";
import { PointsError, isUniqueError, lowerHex } from "../../src/hex.mjs";
import { evaluateChain, expiryAccepts, linkHash, recoverSigner } from "../../src/signature.mjs";

type Sql = {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
};

type Storage = {
  sql: Sql;
  transactionSync<T>(closure: () => T): T;
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS raw_logs (
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
  )`,
  `CREATE TABLE IF NOT EXISTS origins (
    actor_id TEXT PRIMARY KEY,
    actor_type TEXT NOT NULL,
    identity_anchor INTEGER NOT NULL,
    behavioral_signals INTEGER NOT NULL,
    model_version TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS chains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet TEXT NOT NULL,
    action TEXT NOT NULL,
    escrow_id TEXT NOT NULL,
    entries_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS nonces (
    nonce TEXT PRIMARY KEY,
    tx_hash TEXT NOT NULL,
    log_index INTEGER NOT NULL,
    wallet TEXT NOT NULL,
    block_timestamp INTEGER NOT NULL,
    issue_time INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'confirmed', 'revoked')),
    seq INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS nonces_one_open
    ON nonces (tx_hash, log_index, wallet)
    WHERE status = 'open'`,
  `CREATE TABLE IF NOT EXISTS links (
    nonce TEXT PRIMARY KEY,
    escrow_id TEXT NOT NULL,
    action TEXT NOT NULL,
    tx_hash TEXT NOT NULL,
    log_index INTEGER NOT NULL,
    expiry INTEGER NOT NULL,
    wallet TEXT NOT NULL,
    signature TEXT NOT NULL,
    seq INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ledger_rows (
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
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ledger_wallet_action_day
    ON ledger_rows (wallet, action, utc_day)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ledger_log_key
    ON ledger_rows (chain_id, contract, tx_hash, log_index)
    WHERE action IN ('fund', 'release_or_refund', 'dispute_open_or_vote')`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ledger_first_activity
    ON ledger_rows (wallet)
    WHERE action = 'first_activity'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ledger_return_day
    ON ledger_rows (wallet, utc_day)
    WHERE action = 'return_day'`,
];

/** Above this many stored logs, rebuild stops so a flood cannot spend the CPU budget. */
export const REBUILD_MAX_LOGS = 500;

function one(sql: Sql, query: string, ...params: unknown[]) {
  const rows = sql.exec(query, ...params).toArray();
  return rows[0] ?? null;
}

function all(sql: Sql, query: string, ...params: unknown[]) {
  return sql.exec(query, ...params).toArray();
}

function run(sql: Sql, query: string, ...params: unknown[]) {
  sql.exec(query, ...params);
}

export function metaGet(sql: Sql, key: string) {
  const row = one(sql, "SELECT value FROM meta WHERE key = ?", key);
  return row ? String(row.value) : null;
}

export function metaSet(sql: Sql, key: string, value: string) {
  run(
    sql,
    "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    key,
    value,
  );
}

function nullableNumber(value: unknown) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isInteger(number)) throw new PointsError("bad_config");
  return number;
}

function normalizeRegister(register: { voters?: Record<string, string> } | Record<string, string>) {
  const voters = "voters" in register && register.voters ? register.voters : register as Record<string, string>;
  const out: Record<string, string> = {};
  for (const [wallet, kind] of Object.entries(voters)) {
    if (wallet === "voters") continue;
    const address = lowerHex(wallet);
    if (!address || (kind !== "human" && kind !== "ai" && kind !== "pending")) {
      throw new PointsError("bad_register", { wallet });
    }
    out[address] = kind;
  }
  return out;
}

function normalizeWeights(weights: { weights?: Record<string, unknown> }) {
  const source = (weights.weights ?? weights) as Record<string, unknown>;
  return {
    first_activity: nullableNumber(source.first_activity),
    fund: nullableNumber(source.fund),
    release_or_refund: nullableNumber(source.release_or_refund),
    dispute_open_or_vote: nullableNumber(source.dispute_open_or_vote),
    vote: nullableNumber(source.vote),
    return_day: nullableNumber(source.return_day),
  };
}

function normalizeGates(gates: { gates?: Record<string, unknown> }) {
  const source = (gates.gates ?? gates) as Record<string, unknown>;
  return {
    same_pair_per_day: nullableNumber(source.same_pair_per_day),
    same_pair_lifetime: nullableNumber(source.same_pair_lifetime),
    min_escrow_amount_wei: source.min_escrow_amount_wei == null ? null : String(source.min_escrow_amount_wei),
    min_escrow_duration_seconds: nullableNumber(source.min_escrow_duration_seconds),
  };
}

export function ensureSchema(sql: Sql) {
  for (const statement of SCHEMA) sql.exec(statement);
  if (!metaGet(sql, "configured")) {
    refreshBundled(sql);
    metaSet(sql, "configured", "1");
    metaSet(sql, "rebuild_count", "0");
    metaSet(sql, "dirty", "0");
  }
}

function bundleFingerprint(parts: unknown) {
  const text = JSON.stringify(parts);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

/** Replace stored weights, gates, register, chains, and links from the bundled config. */
export function refreshBundled(sql: Sql) {
  const register = JSON.stringify(normalizeRegister(registerConfig));
  const weights = JSON.stringify(normalizeWeights(pointsConfig));
  const gates = JSON.stringify(normalizeGates(pointsConfig));
  const rule = (pointsConfig as { rule_version?: unknown }).rule_version;
  const ruleVersion = typeof rule === "string" ? rule : "";
  const fingerprint = bundleFingerprint({ register, weights, gates, ruleVersion, chains: chainsConfig, links: linksConfig });
  const previous = metaGet(sql, "bundle_hash");
  const configured = metaGet(sql, "configured") === "1";
  metaSet(sql, "register", register);
  metaSet(sql, "weights", weights);
  metaSet(sql, "gates", gates);
  metaSet(sql, "rule_version", ruleVersion);
  run(sql, "DELETE FROM chains");
  for (const chain of chainsConfig as Array<{ wallet?: string; action?: string; escrow_id?: string; entries?: unknown }>) {
    const wallet = lowerHex(chain.wallet);
    const escrowId = lowerHex(chain.escrow_id);
    if (!wallet || !escrowId || !chain.action) continue;
    run(
      sql,
      "INSERT INTO chains(wallet, action, escrow_id, entries_json) VALUES(?, ?, ?, ?)",
      wallet,
      String(chain.action),
      escrowId,
      JSON.stringify(chain.entries ?? []),
    );
  }
  run(sql, "DELETE FROM links");
  for (const link of linksConfig as Array<Record<string, unknown>>) {
    if (link.nonce == null || link.wallet == null) continue;
    run(
      sql,
      `INSERT INTO links(nonce, escrow_id, action, tx_hash, log_index, expiry, wallet, signature, seq)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      String(link.nonce),
      String(link.escrow_id ?? ""),
      String(link.action ?? ""),
      String(link.tx_hash ?? ""),
      Number(link.log_index ?? 0),
      Number(link.expiry ?? 0),
      String(link.wallet),
      String(link.signature ?? ""),
      Number(link.seq ?? 0),
    );
  }
  if ((previous != null && previous !== fingerprint) || (previous == null && configured)) {
    metaSet(sql, "dirty", "1");
  }
  metaSet(sql, "bundle_hash", fingerprint);
}

export function storedConfig(sql: Sql) {
  const weights = JSON.parse(metaGet(sql, "weights") || "null");
  const gates = JSON.parse(metaGet(sql, "gates") || "null");
  const rule = metaGet(sql, "rule_version");
  return {
    weights,
    gates,
    rule_version: rule == null || rule === "" ? null : rule,
  };
}

export function lastScannedBlock(sql: Sql) {
  const raw = metaGet(sql, "last_scanned_block");
  if (raw == null || raw === "") return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : null;
}

export function finalizedBlock(sql: Sql) {
  const raw = metaGet(sql, "finalized_block");
  if (raw == null || raw === "") return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : null;
}

export function metaInt(sql: Sql, key: string) {
  const raw = metaGet(sql, key);
  if (raw == null || raw === "") return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function upsertRaw(sql: Sql, chainId: number, log: ReturnType<typeof normalizeLog>) {
  const existing = one(
    sql,
    "SELECT removed FROM raw_logs WHERE chain_id = ? AND contract = ? AND tx_hash = ? AND log_index = ?",
    chainId,
    log.contract,
    log.txHash,
    log.logIndex,
  );
  if (!existing) {
    run(
      sql,
      `INSERT INTO raw_logs(
         chain_id, contract, tx_hash, log_index, block_number, block_hash, block_timestamp,
         topics_json, data, removed, tx_from
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      chainId,
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
  if (Number(existing.removed) === 1 && !log.removed) {
    run(
      sql,
      `UPDATE raw_logs
       SET block_number = ?, block_hash = ?, block_timestamp = ?, topics_json = ?, data = ?, removed = 0, tx_from = ?
       WHERE chain_id = ? AND contract = ? AND tx_hash = ? AND log_index = ?`,
      log.blockNumber,
      log.blockHash,
      log.blockTimestamp,
      JSON.stringify(log.topics),
      log.data,
      log.txFrom,
      chainId,
      log.contract,
      log.txHash,
      log.logIndex,
    );
    return 1;
  }
  return 0;
}

export function commitScanWindow(
  storage: Storage,
  logs: unknown[],
  scannedThrough: number,
  chainId: number,
  finalizedHead: number,
) {
  if (!isAcceptedChain(chainId)) throw new PointsError("wrong_chain", { chainId });
  if (!Number.isInteger(scannedThrough) || scannedThrough < 0) throw new PointsError("bad_cursor");
  if (!Number.isInteger(finalizedHead) || finalizedHead < 0) throw new PointsError("bad_finalized");
  const previous = lastScannedBlock(storage.sql);
  if (previous != null && scannedThrough < previous) throw new PointsError("cursor_backwards");
  const normalized = logs.map((log) => normalizeLog(log));
  let inserted = 0;
  let removed = 0;
  let anomalies = 0;
  storage.transactionSync(() => {
    for (const log of normalized) {
      if (log.removed) {
        if (log.blockNumber <= finalizedHead) {
          anomalies += 1;
          console.error(JSON.stringify({
            message: "removed_finalized_log",
            block: log.blockNumber,
          }));
          continue;
        }
        throw new PointsError("removed_above_head");
      } else {
        inserted += upsertRaw(storage.sql, chainId, log);
      }
    }
    metaSet(storage.sql, "last_scanned_block", String(scannedThrough));
    if (anomalies > 0) {
      const prior = metaInt(storage.sql, "removed_finalized") ?? 0;
      metaSet(storage.sql, "removed_finalized", String(prior + anomalies));
    }
    if (inserted > 0 || removed > 0) metaSet(storage.sql, "dirty", "1");
  });
  return { ok: true, inserted, removed, anomalies, scannedThrough };
}

export function setFinalizedBlock(sql: Sql, finalized: number) {
  if (!Number.isInteger(finalized) || finalized < 0) throw new PointsError("bad_finalized");
  const current = finalizedBlock(sql);
  const next = current == null ? finalized : Math.max(current, finalized);
  if (current != null && next === current) return { moved: false, previous: current, finalizedBlock: current };
  metaSet(sql, "finalized_block", String(next));
  return { moved: true, previous: current, finalizedBlock: next };
}

/** Raw logs that were stored above the previous finalized head and are final now. */
export function newlyFinalCount(sql: Sql, previous: number | null, next: number) {
  if (previous == null) return 0;
  const row = one(
    sql,
    "SELECT COUNT(*) AS n FROM raw_logs WHERE removed = 0 AND block_number > ? AND block_number <= ?",
    previous,
    next,
  );
  return Number(row?.n ?? 0);
}

function rawObjects(sql: Sql) {
  return all(sql, "SELECT * FROM raw_logs").map((row) => ({
    address: row.contract,
    transactionHash: row.tx_hash,
    blockHash: row.block_hash,
    blockNumber: Number(row.block_number),
    logIndex: Number(row.log_index),
    blockTimestamp: Number(row.block_timestamp),
    topics: JSON.parse(String(row.topics_json)),
    data: row.data,
    removed: Number(row.removed) === 1,
    transactionFrom: row.tx_from,
  }));
}

function origins(sql: Sql) {
  const map = new Map<string, { actorType: string; identityAnchor: boolean; behavioralSignals: boolean; modelVersion: string }>();
  for (const row of all(sql, "SELECT * FROM origins")) {
    map.set(String(row.actor_id), {
      actorType: String(row.actor_type),
      identityAnchor: Number(row.identity_anchor) === 1,
      behavioralSignals: Number(row.behavioral_signals) === 1,
      modelVersion: String(row.model_version),
    });
  }
  return map;
}

function listChains(sql: Sql) {
  return all(sql, "SELECT id, wallet, action, escrow_id, entries_json FROM chains ORDER BY id").map((row) => ({
    id: Number(row.id),
    wallet: String(row.wallet),
    action: String(row.action),
    escrowId: String(row.escrow_id),
    entries: JSON.parse(String(row.entries_json)),
  }));
}

function bump(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) || 0) + 1);
}

function gateReason(candidate: { role?: string; amount?: string | null; createTimestamp?: number | null; expiresAt?: number | null; pair?: string | null; wallet: string; utcDay: number }, gates: ReturnType<typeof normalizeGates>, pairDay: Map<string, number>, pairLife: Map<string, number>) {
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

function voteFields(candidate: { role?: string; wallet: string; action: string }, register: Record<string, string>, weights: ReturnType<typeof normalizeWeights>) {
  if (candidate.role === "vote") {
    const registerStatus = register[candidate.wallet] ?? "pending";
    const configured = weights.vote;
    const registeredHuman = registerStatus === "human";
    const weightSet = configured != null && configured > 0;
    return {
      registerStatus,
      ruleWeight: registeredHuman ? configured : null,
      countsForReturnDay: registeredHuman && weightSet,
    };
  }
  return {
    registerStatus: null,
    ruleWeight: weights[candidate.action as keyof typeof weights] ?? null,
    countsForReturnDay: true,
  };
}

function rowFrom(candidate: {
  chainId: number;
  contract: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockTimestamp: number;
  utcDay: number;
  wallet: string;
  escrowId: string;
  disputeId: string | null;
  support: number | null;
}, fields: { action: string; ruleWeight: number | null; countsForReturnDay: number; registerStatus: string | null; sourceAction: string | null }) {
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

function chainFor(candidate: { wallet: string; action: string; escrowId: string; blockTimestamp: number }, chains: ReturnType<typeof listChains>, originMap: ReturnType<typeof origins>) {
  const latest = chains
    .filter((chain) => chain.wallet === candidate.wallet && chain.action === candidate.action && chain.escrowId === candidate.escrowId)
    .sort((a, b) => b.id - a.id)[0];
  if (!latest) return { accepted: false, reason: "missing_chain" };
  const verdict = evaluateChain(latest.entries, originMap, candidate.blockTimestamp);
  if (verdict.accepted && verdict.terminalWallet !== candidate.wallet) {
    return { accepted: false, reason: "terminal_wallet" };
  }
  return verdict;
}

function linkFor(
  candidate: { txHash: string; logIndex: number; wallet: string; action: string; escrowId: string; blockTimestamp: number },
  links: Array<Record<string, unknown>>,
  nonces: Map<string, Record<string, unknown>>,
) {
  const matches = links
    .filter((link) =>
      link.txHash === candidate.txHash
      && link.logIndex === candidate.logIndex
      && link.wallet === candidate.wallet
      && link.action === candidate.action
      && link.escrowId === candidate.escrowId)
    .sort((a, b) => Number(a.seq) - Number(b.seq));
  let reason = "missing_link";
  for (const link of matches) {
    const nonce = nonces.get(String(link.nonce));
    if (!nonce || nonce.status === "revoked") {
      reason = "nonce_consumed";
      continue;
    }
    if (nonce.status === "confirmed") {
      reason = "duplicate_log";
      continue;
    }
    if (nonce.tx_hash !== candidate.txHash || Number(nonce.log_index) !== candidate.logIndex || nonce.wallet !== candidate.wallet) {
      reason = "binding_mismatch";
      continue;
    }
    if (!expiryAccepts(candidate.blockTimestamp, Number(link.expiry))) {
      reason = "expiry";
      continue;
    }
    const digest = linkHash(link);
    if (typeof digest !== "string") {
      reason = (digest as { reason?: string } | null)?.reason || "bad_link";
      continue;
    }
    const recovered = recoverSigner(digest, String(link.signature));
    if (!recovered.ok) {
      reason = recovered.reason || "bad_signature";
      continue;
    }
    if (recovered.address !== candidate.wallet) {
      reason = "signer_mismatch";
      continue;
    }
    return { ok: true as const, nonce: String(link.nonce) };
  }
  return { ok: false as const, reason };
}

export function applyFailClosed<T extends Record<string, unknown>>(row: T) {
  return {
    ...row,
    points: 0,
    eligibility_status: "unverified",
    eligibility_reason: "ofac_unconfigured",
    points_withheld: 1,
  };
}

export function insertLedgerRow(sql: Sql, row: Record<string, unknown>) {
  const stored = applyFailClosed(row);
  if (stored.points !== 0) throw new PointsError("score_not_zero");
  try {
    run(
      sql,
      `INSERT INTO ledger_rows(
         seq, chain_id, contract, tx_hash, log_index, block_number, block_timestamp, utc_day,
         wallet, action, escrow_id, points, eligibility_status, eligibility_reason, points_withheld,
         rule_weight, counts_for_return_day, register_status, dispute_id, support,
         source_action, source_tx_hash, source_log_index
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      stored.seq,
      stored.chain_id,
      stored.contract,
      stored.tx_hash,
      stored.log_index,
      stored.block_number,
      stored.block_timestamp,
      stored.utc_day,
      stored.wallet,
      stored.action,
      stored.escrow_id,
      stored.points,
      stored.eligibility_status,
      stored.eligibility_reason,
      stored.points_withheld,
      stored.rule_weight ?? null,
      stored.counts_for_return_day,
      stored.register_status ?? null,
      stored.dispute_id ?? null,
      stored.support ?? null,
      stored.source_action ?? null,
      stored.source_tx_hash ?? null,
      stored.source_log_index ?? null,
    );
    return true;
  } catch (error) {
    if (isUniqueError(error)) return false;
    throw error;
  }
}

function settleNonceStatuses(sql: Sql, nonces: Map<string, Record<string, unknown>>) {
  const openByKey = new Map<string, Record<string, unknown>>();
  for (const row of nonces.values()) {
    if (row.status !== "open") continue;
    const key = `${row.tx_hash}|${row.log_index}|${row.wallet}`;
    const current = openByKey.get(key);
    if (!current || Number(row.seq) > Number(current.seq)) {
      if (current) current.status = "revoked";
      openByKey.set(key, row);
    } else {
      row.status = "revoked";
    }
  }
  for (const row of nonces.values()) {
    run(sql, "UPDATE nonces SET status = ? WHERE nonce = ?", row.status, row.nonce);
  }
}

export function rebuild(storage: Storage) {
  const sql = storage.sql;
  const head = finalizedBlock(sql);
  if (head == null) throw new PointsError("bad_finalized");
  const rawCount = Number(one(sql, "SELECT COUNT(*) AS n FROM raw_logs")?.n ?? 0);
  if (rawCount > REBUILD_MAX_LOGS) {
    metaSet(sql, "rebuild_capped", "1");
    metaSet(sql, "dirty", "1");
    console.error(JSON.stringify({ message: "rebuild_capped", rows: rawCount }));
    return;
  }
  const weights = JSON.parse(metaGet(sql, "weights") || "{}") as ReturnType<typeof normalizeWeights>;
  const gates = JSON.parse(metaGet(sql, "gates") || "{}") as ReturnType<typeof normalizeGates>;
  const register = JSON.parse(metaGet(sql, "register") || "{}") as Record<string, string>;
  const logs = rawObjects(sql);
  const attribution = attributeLogs(logs, {
    finalizedBlock: head,
    chainId: CHAIN_ID,
    includeUnfinalized: false,
  });
  const originMap = origins(sql);
  const chains = listChains(sql);
  const nonces = new Map(
    all(sql, "SELECT * FROM nonces").map((row) => {
      if (row.status === "confirmed") row.status = "open";
      return [String(row.nonce), row] as const;
    }),
  );
  const links = all(sql, "SELECT * FROM links ORDER BY seq").map((row) => ({
    nonce: String(row.nonce),
    escrowId: String(row.escrow_id),
    action: String(row.action),
    txHash: String(row.tx_hash),
    logIndex: Number(row.log_index),
    expiry: Number(row.expiry),
    wallet: String(row.wallet),
    signature: String(row.signature),
    seq: Number(row.seq),
  }));

  storage.transactionSync(() => {
    run(sql, "DELETE FROM ledger_rows");
    const firstDay = new Map<string, number>();
    const returnDays = new Set<string>();
    const pairDay = new Map<string, number>();
    const pairLife = new Map<string, number>();
    let seq = 0;
    const daySlot = new Set<string>();
    const logSlot = new Set<string>();
    const pending: Array<ReturnType<typeof rowFrom>> = [];

    const tryInsert = (row: ReturnType<typeof rowFrom>) => {
      const dayKey = `${row.wallet}|${row.action}|${row.utc_day}`;
      const logKey = `${row.chain_id}|${row.contract}|${row.tx_hash}|${row.log_index}`;
      if (daySlot.has(dayKey)) return false;
      if ((row.action === ACTION.fund || row.action === ACTION.releaseOrRefund || row.action === ACTION.disputeOpenOrVote) && logSlot.has(logKey)) {
        return false;
      }
      if (row.action === ACTION.firstActivity && firstDay.has(row.wallet)) return false;
      if (row.action === ACTION.returnDay && returnDays.has(`${row.wallet}|${row.utc_day}`)) return false;
      seq += 1;
      pending.push({ ...row });
      const stored = pending[pending.length - 1];
      stored.points = 0;
      stored.eligibility_status = "unverified";
      stored.eligibility_reason = "ofac_unconfigured";
      stored.points_withheld = 1;
      daySlot.add(dayKey);
      if (row.action === ACTION.fund || row.action === ACTION.releaseOrRefund || row.action === ACTION.disputeOpenOrVote) {
        logSlot.add(logKey);
      }
      return true;
    };

    for (const candidate of attribution.candidates) {
      if (!candidate.finalized) continue;
      const chain = chainFor(candidate, chains, originMap);
      if (!chain.accepted) continue;
      const link = linkFor(candidate, links, nonces);
      if (!link.ok) continue;
      const gate = gateReason(candidate, gates, pairDay, pairLife);
      if (gate) continue;
      const vote = voteFields(candidate, register, weights);
      const inserted = tryInsert(rowFrom(candidate, {
        action: candidate.action,
        ruleWeight: vote.ruleWeight,
        countsForReturnDay: vote.countsForReturnDay ? 1 : 0,
        registerStatus: vote.registerStatus,
        sourceAction: null,
      }));
      if (!inserted) continue;
      const nonce = nonces.get(link.nonce);
      if (nonce) nonce.status = "confirmed";
      if (candidate.role !== "vote" && candidate.pair) {
        bump(pairDay, `${candidate.wallet}|${candidate.pair}|${candidate.utcDay}`);
        bump(pairLife, `${candidate.wallet}|${candidate.pair}`);
      }
      if (candidate.role !== "vote" && !firstDay.has(candidate.wallet)) {
        const derived = tryInsert(rowFrom(candidate, {
          action: ACTION.firstActivity,
          ruleWeight: weights.first_activity,
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
          ruleWeight: weights.return_day,
          countsForReturnDay: 0,
          registerStatus: null,
          sourceAction: candidate.action,
        }));
        if (derived) returnDays.add(`${candidate.wallet}|${candidate.utcDay}`);
      }
    }

    pending.sort(compareRows);
    pending.forEach((row, index) => {
      insertLedgerRow(sql, { ...row, seq: index + 1 });
    });
    settleNonceStatuses(sql, nonces);
    const count = metaInt(sql, "rebuild_count") ?? 0;
    metaSet(sql, "rebuild_count", String(count + 1));
    metaSet(sql, "dirty", "0");
    metaSet(sql, "rebuild_capped", "0");
  });
}
