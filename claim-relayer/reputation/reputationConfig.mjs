import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_SEPOLIA_CHAIN_ID, httpError } from "../config.mjs";

export const USAGE_LEDGER = "agent-bv-sepolia-reputation";
export const ARBITRATOR_LEDGER = "agent-bv-sepolia-arbitrator-rep";
export const CONFIG_DIR = fileURLToPath(new URL("../../config/reputation/", import.meta.url));

const REFUSED = new Set([1, 8453]);

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    throw httpError(500, "reputation_config_unreadable", { path: filePath });
  }
}

function guessInt(node, label) {
  const value = node && typeof node === "object" ? node.value : node;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  throw httpError(500, "reputation_config_invalid", { field: label });
}

function guessWei(node, label) {
  const value = node && typeof node === "object" ? node.value : node;
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    throw httpError(500, "reputation_config_invalid", { field: label });
  }
  return BigInt(value);
}

/** Keep an https link. Anything else, including http, becomes an empty string. */
export function httpsLink(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  try {
    if (new URL(text).protocol !== "https:") return "";
  } catch {
    return "";
  }
  return text;
}

export function normalizeVersion(raw) {
  if (!raw || raw.chain?.chain_id !== BASE_SEPOLIA_CHAIN_ID) {
    throw httpError(500, "wrong_chain", { chainId: raw?.chain?.chain_id });
  }
  for (const id of raw.chain.refused_chain_ids || []) {
    if (!REFUSED.has(Number(id)) && Number(id) === BASE_SEPOLIA_CHAIN_ID) {
      throw httpError(500, "reputation_config_invalid", { field: "refused_chain_ids" });
    }
  }
  if (raw.ledgers?.usage !== USAGE_LEDGER || raw.ledgers?.arbitrator !== ARBITRATOR_LEDGER) {
    throw httpError(500, "reputation_config_invalid", { field: "ledgers" });
  }
  if (raw.ledgers.never_summed !== true) {
    throw httpError(500, "reputation_config_invalid", { field: "never_summed" });
  }
  const day = raw.day_implementation?.value;
  if (day !== "utc_day_by_block_timestamp") {
    throw httpError(500, "reputation_config_invalid", { field: "day_implementation" });
  }
  const names = productNames(raw.product);
  return {
    product: names.name,
    product_title: names.title,
    config_version: String(raw.config_version),
    rule_version: String(raw.rule_version),
    effective_from_block: guessInt({ value: raw.effective_from_block ?? 0 }, "effective_from_block"),
    contracts: {
      vault: contractSlot(raw.contracts.vault),
      escrow: contractSlot(raw.contracts.escrow),
      dispute_panel: contractSlot(raw.contracts.dispute_panel),
      denylist: contractSlot(raw.contracts.denylist),
    },
    points: {
      O1: guessInt(raw.points.O1_operator, "O1"),
      O2_payer: guessInt(raw.points.O2_payer, "O2_payer"),
      O2_payee: guessInt(raw.points.O2_payee, "O2_payee"),
      O3_payer: guessInt(raw.points.O3_payer, "O3_payer"),
      O3_payee: guessInt(raw.points.O3_payee, "O3_payee"),
      O4_payer: guessInt(raw.points.O4_payer, "O4_payer"),
      O4_payee: guessInt(raw.points.O4_payee, "O4_payee"),
      O5: guessInt(raw.points.O5, "O5"),
      A1: guessInt(raw.points.A1_per_vote, "A1"),
      A2: guessInt(raw.points.A2_match_bonus, "A2"),
    },
    floors: {
      min_amount_wei: guessWei(raw.floors.min_amount_wei, "min_amount_wei"),
      o2_seconds: guessInt(raw.floors.o2_min_create_to_release_seconds, "o2_seconds"),
      o3_seconds: guessInt(raw.floors.o3_min_set_duration_seconds, "o3_seconds"),
    },
    caps: {
      label: raw.caps._label || raw.display?.caps_label || "DRAFT/GUESS",
      usage_points_per_wallet_per_day: guessInt(raw.caps.usage_points_per_wallet_per_day, "wallet_day"),
      usage_points_per_bot_per_day: guessInt(raw.caps.usage_points_per_bot_per_day, "bot_day"),
      escrows_per_wallet_per_day: guessInt(raw.caps.escrows_per_wallet_per_day, "escrow_day"),
      o3_per_wallet_per_day: guessInt(raw.caps.o3_per_wallet_per_day, "o3_day"),
      o4_per_wallet_per_day: guessInt(raw.caps.o4_per_wallet_per_day, "o4_day"),
      pair_per_day: guessInt(raw.caps.pair_per_day, "pair_day"),
      pair_lifetime: guessInt(raw.caps.pair_lifetime, "pair_life"),
      usage_points_per_wallet_per_season: guessInt(raw.caps.usage_points_per_wallet_per_season, "season"),
      arbitrator_points_per_day: guessInt(raw.caps.arbitrator_points_per_day, "arb_day"),
    },
    flags: {
      o5_threshold: guessInt(raw.flags.o5_standalone_disputes_threshold, "o5_threshold"),
      o5_window_days: guessInt(raw.flags.o5_window_days, "o5_window"),
    },
    gates: normalizeGates(raw.gates),
    excluded: excludedAddresses(raw.excluded_addresses),
    season: normalizeSeason(raw),
    disclaimer: String(raw.display?.disclaimer || ""),
    disclaimer_links: {
      master_disclaimer: String(raw.disclaimer_links?.master_disclaimer || ""),
      legal_notice_url: httpsLink(raw.disclaimer_links?.legal_notice_url),
      as_is: String(raw.disclaimer_links?.as_is || ""),
      not_investment: String(raw.disclaimer_links?.not_investment || ""),
      eligibility_notice: String(raw.disclaimer_links?.eligibility_notice || ""),
      abuse_policy: String(raw.disclaimer_links?.abuse_policy || ""),
    },
    caps_label: String(raw.display?.caps_label || "DRAFT/GUESS"),
    read_api: {
      rate_limit_per_minute: guessInt({ value: raw.read_api?.rate_limit_per_minute ?? 60 }, "rate"),
      history_page_default: guessInt({ value: raw.read_api?.history_page_default ?? 25 }, "page"),
      history_page_max: guessInt({ value: raw.read_api?.history_page_max ?? 100 }, "page_max"),
    },
    scan_max_block_range: guessInt({ value: raw.scan?.max_block_range ?? 625 }, "scan"),
  };
}

function productNames(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw httpError(500, "reputation_config_invalid", { field: "product" });
  }
  const out = {};
  for (const field of ["name", "title"]) {
    const text = value[field];
    if (typeof text !== "string" || text.trim() === "" || text !== text.trim()) {
      throw httpError(500, "reputation_config_invalid", { field: `product.${field}` });
    }
    out[field] = text;
  }
  return out;
}

function normalizeGates(gates) {
  const gate = gates?.o1_tier_gate;
  if (!gate || typeof gate.enabled !== "boolean") {
    throw httpError(500, "reputation_config_invalid", { field: "o1_tier_gate" });
  }
  return {
    o1_tier_enabled: gate.enabled,
    o1_min_tier: guessInt(gate.min_tier, "o1_min_tier"),
  };
}

function excludedAddresses(raw) {
  if (!raw || !Array.isArray(raw.entries)) {
    throw httpError(500, "reputation_config_invalid", { field: "excluded_addresses" });
  }
  const set = new Set();
  for (const entry of raw.entries) {
    if (!entry || entry.address == null || entry.address === "") continue;
    if (typeof entry.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(entry.address)) {
      throw httpError(500, "reputation_config_invalid", { field: "excluded_address" });
    }
    set.add(entry.address.toLowerCase());
  }
  return set;
}

function nullableInt(node, label) {
  const value = node && typeof node === "object" && "value" in node ? node.value : node;
  if (value === null || value === undefined) return null;
  return guessInt({ value }, label);
}

function normalizeSeason(raw) {
  return {
    length_days: guessInt(raw.caps?.season_length_days, "season_length_days"),
    start_block: nullableInt(raw.caps?.season_start_block, "season_start_block"),
    start_timestamp: nullableInt(raw.caps?.season_start_timestamp, "season_start_timestamp"),
  };
}

function contractSlot(slot) {
  if (!slot || typeof slot.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(slot.address)) {
    throw httpError(500, "reputation_config_invalid", { field: "contract_address" });
  }
  if (!Number.isSafeInteger(slot.start_block) || slot.start_block < 0) {
    throw httpError(500, "reputation_config_invalid", { field: "start_block" });
  }
  return {
    name: slot.name,
    address: slot.address,
    address_lower: slot.address.toLowerCase(),
    start_block: slot.start_block,
  };
}

export function versionAt(versions, blockNumber) {
  let chosen = null;
  for (const version of versions) {
    if (version.effective_from_block <= blockNumber) chosen = version;
  }
  return chosen;
}

export function loadReputationConfig(dir = CONFIG_DIR) {
  const timeline = readJson(join(dir, "timeline.json"));
  const versions = (timeline.versions || []).map((row) => {
    const raw = readJson(join(dir, row.config_file));
    raw.effective_from_block = row.effective_from_block;
    return normalizeVersion(raw);
  });
  versions.sort((a, b) => a.effective_from_block - b.effective_from_block);
  if (versions.length === 0) throw httpError(500, "reputation_config_invalid", { field: "versions" });
  const adjustmentsRaw = readJson(join(dir, "adjustments.json"));
  const adjustments = validateAdjustments(adjustmentsRaw.adjustments || []);
  return { versions, adjustments, latest: versions[versions.length - 1] };
}

export function validateAdjustments(rows) {
  if (!Array.isArray(rows)) throw httpError(500, "reputation_config_invalid", { field: "adjustments" });
  return rows.map((row) => {
    if (!row || typeof row.adjustment_id !== "string" || !row.adjustment_id.trim()) {
      throw httpError(500, "reputation_config_invalid", { field: "adjustment_id" });
    }
    if (row.ledger !== USAGE_LEDGER && row.ledger !== ARBITRATOR_LEDGER) {
      throw httpError(500, "reputation_config_invalid", { field: "adjustment_ledger" });
    }
    if (!Number.isSafeInteger(row.points) || row.points > 0) {
      throw httpError(500, "adjustment_points_not_negative", { adjustment_id: row.adjustment_id });
    }
    if (row.points < 0 && row.cancels_entry_id) {
      throw httpError(500, "adjustment_ambiguous", { adjustment_id: row.adjustment_id });
    }
    if (!Number.isSafeInteger(row.effective_block) || !Number.isSafeInteger(row.block_timestamp)) {
      throw httpError(500, "reputation_config_invalid", { field: "adjustment_block" });
    }
    if (typeof row.cancel_reason !== "string" || typeof row.cancelled_by !== "string") {
      throw httpError(500, "reputation_config_invalid", { field: "cancel_reason" });
    }
    return {
      adjustment_id: row.adjustment_id,
      ledger: row.ledger,
      wallet: row.wallet,
      bot_id: row.bot_id || null,
      points: row.points,
      effective_block: row.effective_block,
      block_timestamp: row.block_timestamp,
      cancel_reason: row.cancel_reason,
      cancelled_by: row.cancelled_by,
      cancels_entry_id: row.cancels_entry_id || null,
    };
  });
}
