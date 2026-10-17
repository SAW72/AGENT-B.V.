/**
 * Sqlite adapter for the read-api store.
 * It wraps the database handle the indexer already opened.
 * The read core does not import this file.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CHAIN_ID } from "./constants.mjs";

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

function loadPointsFile() {
  const filePath = fileURLToPath(new URL("../config/points.json", import.meta.url));
  const raw = JSON.parse(readFileSync(filePath, "utf8"));
  const weights = {};
  for (const key of WEIGHT_KEYS) weights[key] = scalarOrNull(raw?.weights?.[key]);
  const gates = {};
  for (const key of GATE_KEYS) gates[key] = scalarOrNull(raw?.gates?.[key]);
  const rule = raw?.rule_version;
  const ruleVersion = rule == null ? null : (typeof rule === "string" ? rule : null);
  return { weights, gates, rule_version: ruleVersion };
}

function emptyCursor() {
  return {
    last_scanned_block: null,
    finalized_block: null,
    pass_completed: false,
  };
}

function emptySummary() {
  return {
    points_total: 0,
    rows_count: 0,
    first_activity_utc_day: null,
  };
}

/**
 * @param {{ db?: () => object | null, lastScannedBlock?: () => number | null, finalizedBlock?: () => number | null, passCompleted?: () => boolean }} source
 */
export function createReadApiSqliteStore(source = {}) {
  const db = typeof source.db === "function" ? source.db : () => null;
  const lastScannedBlock = typeof source.lastScannedBlock === "function" ? source.lastScannedBlock : () => null;
  const finalizedBlock = typeof source.finalizedBlock === "function" ? source.finalizedBlock : () => null;
  const passCompleted = typeof source.passCompleted === "function" ? source.passCompleted : () => false;

  return {
    getCursor() {
      if (!db()) return emptyCursor();
      return {
        last_scanned_block: asInt(lastScannedBlock()),
        finalized_block: asInt(finalizedBlock()),
        pass_completed: passCompleted() === true,
      };
    },
    getLedgerSummary(address) {
      const database = db();
      if (!database) return emptySummary();
      const totals = database.prepare(
        `SELECT COALESCE(SUM(points), 0) AS points_total, COUNT(*) AS rows_count
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
      const afterSeq = query?.afterSeq ?? 0;
      return database.prepare(
        `SELECT * FROM ledger_rows
         WHERE wallet = ? AND chain_id = ? AND seq > ?
         ORDER BY seq ASC
         LIMIT ?`,
      ).all(address, CHAIN_ID, afterSeq, limit);
    },
    getConfig() {
      return loadPointsFile();
    },
  };
}
