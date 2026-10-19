/**
 * Sqlite adapter for the read-api store.
 * It wraps the database handle the indexer already opened.
 * The read core does not import this file.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHAIN_ID } from "./constants.mjs";
import { historyRank } from "./readApi.mjs";

const WEIGHT_KEYS = [
  "first_activity",
  "fund",
  "release_or_refund",
  "dispute_open_or_vote",
  "vote",
  "return_day",
];
const GATE_KEYS = [
  "same_pair_per_day",
  "same_pair_lifetime",
  "min_escrow_amount_wei",
  "min_escrow_duration_seconds",
];

function asInt(value) {
  return Number.isSafeInteger(value) ? value : null;
}

function scalarOrNull(value) {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") return value;
  return null;
}

/**
 * Paths inside the image. `src/` and `config/` both sit under `/app`.
 * The notice file in git is `config/reputation/sepolia.json` at the repo
 * root. The image copies that file to `/app/config/reputation/sepolia.json`.
 * A checkout falls back to the repo-root file when the image path is absent.
 * @param {URL | string} [moduleUrl]
 */
export function resolveReadConfigPaths(moduleUrl = import.meta.url) {
  const packageRoot = dirname(dirname(fileURLToPath(moduleUrl)));
  return {
    points: join(packageRoot, "config", "points.json"),
    notice: join(packageRoot, "config", "reputation", "sepolia.json"),
    noticeFallback: join(packageRoot, "..", "..", "config", "reputation", "sepolia.json"),
  };
}

function parseConfigObject(text) {
  const raw = JSON.parse(text);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config_unavailable");
  }
  return raw;
}

function readFirst(read, paths) {
  let missing = null;
  for (const filePath of paths) {
    if (!filePath) continue;
    try {
      return read(filePath, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") {
        missing = error;
        continue;
      }
      throw error;
    }
  }
  throw missing ?? new Error("config_unavailable");
}

function loadReadConfig(read, paths) {
  const points = parseConfigObject(read(paths.points, "utf8"));
  if (points.weights != null && (typeof points.weights !== "object" || Array.isArray(points.weights))) {
    throw new Error("config_unavailable");
  }
  if (points.gates != null && (typeof points.gates !== "object" || Array.isArray(points.gates))) {
    throw new Error("config_unavailable");
  }
  const notice = parseConfigObject(readFirst(read, [paths.notice, paths.noticeFallback]));
  if (
    notice.disclaimer_links != null
    && (typeof notice.disclaimer_links !== "object" || Array.isArray(notice.disclaimer_links))
  ) {
    throw new Error("config_unavailable");
  }
  const link = notice.disclaimer_links?.legal_notice_url;
  if (link != null && typeof link !== "string") throw new Error("config_unavailable");
  const weights = {};
  for (const key of WEIGHT_KEYS) weights[key] = scalarOrNull(points.weights?.[key]);
  const gates = {};
  for (const key of GATE_KEYS) gates[key] = scalarOrNull(points.gates?.[key]);
  const rule = points.rule_version;
  const ruleVersion = rule == null ? null : (typeof rule === "string" ? rule : null);
  return Object.freeze({
    weights: Object.freeze(weights),
    gates: Object.freeze(gates),
    rule_version: ruleVersion,
    legal_notice_url: typeof link === "string" ? link : null,
  });
}

function emptyCursor() {
  return {
    last_scanned_block: null,
    finalized_block: null,
    pass_completed: false,
    stale: false,
  };
}

const ACTION_RANK_SQL = `CASE action
        WHEN 'fund' THEN 1
        WHEN 'release_or_refund' THEN 2
        WHEN 'dispute_open_or_vote' THEN 3
        WHEN 'first_activity' THEN 4
        WHEN 'return_day' THEN 5
        ELSE 9 END`;

function emptySummary() {
  return {
    points_total: 0,
    rows_count: 0,
    first_activity_utc_day: null,
  };
}

/**
 * @param {{ db?: () => object | null, lastScannedBlock?: () => number | null, finalizedBlock?: () => number | null, passCompleted?: () => boolean, stale?: () => boolean }} source
 */
export function createReadApiSqliteStore(source = {}) {
  const db = typeof source.db === "function" ? source.db : () => null;
  const read = typeof source.readFile === "function" ? source.readFile : readFileSync;
  const paths = source.configPaths ?? resolveReadConfigPaths();
  let cachedConfig = null;
  let configAvailable = true;
  try {
    cachedConfig = loadReadConfig(read, paths);
  } catch {
    configAvailable = false;
    cachedConfig = null;
  }
  const lastScannedBlock = typeof source.lastScannedBlock === "function" ? source.lastScannedBlock : () => null;
  const finalizedBlock = typeof source.finalizedBlock === "function" ? source.finalizedBlock : () => null;
  const passCompleted = typeof source.passCompleted === "function" ? source.passCompleted : () => false;
  const stale = typeof source.stale === "function" ? source.stale : () => false;

  return {
    configAvailable,
    getCursor() {
      if (!db()) return { ...emptyCursor(), stale: stale() === true };
      return {
        last_scanned_block: asInt(lastScannedBlock()),
        finalized_block: asInt(finalizedBlock()),
        pass_completed: passCompleted() === true,
        stale: stale() === true,
      };
    },
    getLedgerSummary(address) {
      const database = db();
      if (!database) return emptySummary();
      const totals = database.prepare(
        `SELECT COALESCE(SUM(CASE WHEN points_withheld = 0 THEN points ELSE 0 END), 0) AS points_total,
                COUNT(*) AS rows_count
         FROM ledger_rows WHERE wallet = ? AND chain_id = ?`,
      ).get(address, CHAIN_ID);
      const first = database.prepare(
        `SELECT utc_day FROM ledger_rows
         WHERE wallet = ? AND chain_id = ? AND action = 'first_activity'
         LIMIT 1`,
      ).get(address, CHAIN_ID);
      return {
        points_total: Number(totals.points_total),
        rows_count: Number(totals.rows_count),
        first_activity_utc_day: first ? first.utc_day : null,
      };
    },
    listLedgerRows(address, query) {
      const database = db();
      if (!database) return [];
      const limit = query?.limit;
      const after = query?.after;
      if (!after) {
        return database.prepare(
          `SELECT * FROM ledger_rows
           WHERE wallet = ? AND chain_id = ?
           ORDER BY block_number ASC, log_index ASC, (${ACTION_RANK_SQL}) ASC, utc_day ASC
           LIMIT ?`,
        ).all(address, CHAIN_ID, limit);
      }
      return database.prepare(
        `SELECT * FROM ledger_rows
         WHERE wallet = @wallet AND chain_id = @chain
           AND (
             block_number > @block
             OR (block_number = @block AND log_index > @logIndex)
             OR (block_number = @block AND log_index = @logIndex AND (${ACTION_RANK_SQL}) > @rank)
             OR (block_number = @block AND log_index = @logIndex AND (${ACTION_RANK_SQL}) = @rank AND utc_day > @utcDay)
           )
         ORDER BY block_number ASC, log_index ASC, (${ACTION_RANK_SQL}) ASC, utc_day ASC
         LIMIT @limit`,
      ).all({
        wallet: address,
        chain: CHAIN_ID,
        block: after.block_number,
        logIndex: after.log_index,
        rank: historyRank(after.action),
        utcDay: after.utc_day,
        limit,
      });
    },
    getConfig() {
      if (!configAvailable) {
        const error = new Error("config_unavailable");
        error.code = "config_unavailable";
        throw error;
      }
      return cachedConfig;
    },
  };
}
