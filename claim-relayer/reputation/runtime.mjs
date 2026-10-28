import { httpError } from "../config.mjs";
import { createDefaultHooks } from "./hooks.mjs";
import { ARBITRATOR_LEDGER, USAGE_LEDGER, loadReputationConfig } from "./reputationConfig.mjs";
import { contribution, refuseReputationChain, replayLedger } from "./replay.mjs";

const BANNED_COPY = /\b(reward|earn|earnings|apy|yield|allocation)\b/i;
const LEDGER_QUERY = {
  usage: USAGE_LEDGER,
  arbitrator: ARBITRATOR_LEDGER,
};

export const HISTORY_FIELDS = [
  "entry_id",
  "ledger",
  "chain_id",
  "wallet",
  "bot_id",
  "outcome_code",
  "points",
  "status",
  "source_contract",
  "event_names",
  "tx_hash",
  "log_index",
  "block_number",
  "block_hash",
  "block_timestamp",
  "escrow_id",
  "dispute_id",
  "rule_version",
  "config_version",
  "cancel_reason",
  "cancelled_by",
];

export function createReputationRuntime(options = {}) {
  const loaded = options.versions
    ? { versions: options.versions, adjustments: options.adjustments || [], latest: options.versions[options.versions.length - 1] }
    : loadReputationConfig();
  const latest = loaded.latest || loaded.versions[loaded.versions.length - 1];
  const hooks = options.hooks || createDefaultHooks();
  assertCopy(latest.disclaimer);
  return {
    latest,
    hooks,
    replay() {
      return replayLedger({
        chainId: 84532,
        logs: options.logs || [],
        safeBlock: options.safeBlock,
        finalizedBlock: options.finalizedBlock,
        versions: options.versions,
        adjustments: options.adjustments,
        hooks,
      });
    },
  };
}

export function handleReputationRequest(runtime, url) {
  // TODO: require auth before mainnet. This GET stays open on Base Sepolia.
  const path = url.pathname.replace(/\/+$/, "") || "/";
  parseReputationChainQuery(url.searchParams.get("chainId"));
  if (path === "/v1/reputation/config") return configBody(runtime);
  const match = path.match(/^\/v1\/reputation\/(0x[0-9a-fA-F]{40})(\/history)?$/);
  if (!match) {
    if (path === "/v1/reputation" || path.startsWith("/v1/reputation/")) {
      throw httpError(400, "invalid_address");
    }
    throw httpError(404, "not_found");
  }
  const wallet = match[1].toLowerCase();
  const result = runtime.replay();
  if (match[2] === "/history") return historyBody(runtime, result, wallet, url);
  return balanceBody(runtime, result, wallet);
}

export function parseReputationChainQuery(raw) {
  if (raw === null) return 84532;
  if (raw === "84532") return 84532;
  if (raw === "1" || raw === "8453") refuseReputationChain(raw);
  throw httpError(400, "wrong_chain", { chainId: /^-?[0-9]+$/.test(raw) ? Number(raw) : raw });
}

function balanceBody(runtime, result, wallet) {
  const latest = runtime.latest;
  return {
    address: wallet,
    chainId: 84532,
    ledgers: {
      usage: ledgerPoints(result, wallet, USAGE_LEDGER),
      arbitrator: ledgerPoints(result, wallet, ARBITRATOR_LEDGER),
    },
    eligibility: eligibilityView(runtime, result, wallet),
    config_version: latest.config_version,
    rule_version: latest.rule_version,
    indexed_to_block: result.head.indexed_to_block,
    indexed_to_block_timestamp: result.head.indexed_to_block_timestamp,
    finalized_block: result.head.finalized_block,
    disclaimer: {
      text: latest.disclaimer,
      links: disclaimerLinks(latest.disclaimer_links),
    },
  };
}

function historyBody(runtime, result, wallet, url) {
  const latest = runtime.latest;
  const ledgerName = url.searchParams.get("ledger");
  const ledger = LEDGER_QUERY[ledgerName];
  if (!ledger) throw httpError(400, "invalid_ledger");
  const limit = parseLimit(url.searchParams.get("limit"), latest);
  const cursor = parseCursor(url.searchParams.get("cursor"));
  let rows = result.entries.filter(
    (entry) => entry.ledger === ledger && entry.wallet.toLowerCase() === wallet,
  );
  rows.sort(historyCmp);
  if (cursor) {
    const synthetic = { block_number: cursor.b, log_index: cursor.l, entry_id: cursor.e };
    rows = rows.filter((entry) => historyCmp(synthetic, entry) < 0);
  }
  const page = rows.slice(0, limit);
  const next = rows.length > limit ? encodeCursor(page[page.length - 1]) : null;
  return {
    address: wallet,
    chainId: 84532,
    ledger: ledgerName,
    items: page.map(historyItem),
    next_cursor: next,
  };
}

function configBody(runtime) {
  const latest = runtime.latest;
  const status = /draft/i.test(latest.caps_label) ? "draft" : "locked";
  const slot = (value) => ({ value, status });
  return {
    chainId: 84532,
    config_version: latest.config_version,
    rule_version: latest.rule_version,
    product: latest.product,
    product_title: latest.product_title,
    status,
    ...(latest.points_ledger_status ? { points_ledger_status: latest.points_ledger_status } : {}),
    caps: {
      usage_points_per_wallet_per_day: slot(latest.caps.usage_points_per_wallet_per_day),
      usage_points_per_bot_per_day: slot(latest.caps.usage_points_per_bot_per_day),
      escrows_per_wallet_per_day: slot(latest.caps.escrows_per_wallet_per_day),
      o3_per_wallet_per_day: slot(latest.caps.o3_per_wallet_per_day),
      o4_per_wallet_per_day: slot(latest.caps.o4_per_wallet_per_day),
      pair_per_day: slot(latest.caps.pair_per_day),
      pair_lifetime: slot(latest.caps.pair_lifetime),
      usage_points_per_wallet_per_season: slot(latest.caps.usage_points_per_wallet_per_season),
      arbitrator_points_per_day: slot(latest.caps.arbitrator_points_per_day),
    },
    thresholds: {
      min_amount_wei: slot(latest.floors.min_amount_wei.toString()),
      o2_min_create_to_release_seconds: slot(latest.floors.o2_seconds),
      o3_min_set_duration_seconds: slot(latest.floors.o3_seconds),
      o5_standalone_disputes_threshold: slot(latest.flags.o5_threshold),
      o5_window_days: slot(latest.flags.o5_window_days),
      day_boundary: slot("utc_day_by_block_timestamp"),
      season_length_days: slot(latest.season.length_days),
      season_start_block: slot(latest.season.start_block),
      season_start_timestamp: slot(latest.season.start_timestamp),
    },
  };
}

function ledgerPoints(result, wallet, ledger) {
  let finalPoints = 0;
  let provisionalPoints = 0;
  for (const entry of result.entries) {
    if (entry.ledger !== ledger) continue;
    if (entry.wallet.toLowerCase() !== wallet) continue;
    const points = contribution(entry);
    if (entry.status === "final") finalPoints += points;
    else if (entry.status === "provisional") provisionalPoints += points;
  }
  return {
    ledger,
    final: finalPoints,
    provisional: provisionalPoints,
  };
}

function eligibilityView(runtime, result, wallet) {
  const screen = runtime.hooks.eligibility({
    wallet,
    outcome_code: null,
    block_number: result.head.indexed_to_block,
  }) || {};
  const enforcerWithheld = (result.enforcer_flags || []).some(
    (flag) => flag.withhold_wallet && String(flag.wallet || "").toLowerCase() === wallet,
  );
  const pointsWithheld = screen.points_withheld === true || screen.eligible === false || enforcerWithheld;
  const status = typeof screen.status === "string" && screen.status
    ? screen.status
    : screen.eligible
      ? "eligible"
      : "unverified";
  return { status, points_withheld: pointsWithheld };
}

function disclaimerLinks(links) {
  const out = {};
  for (const key of [
    "master_disclaimer",
    "legal_notice_url",
    "as_is",
    "not_investment",
    "eligibility_notice",
    "abuse_policy",
  ]) {
    const value = String(links?.[key] || "").trim();
    out[key] = value ? value : null;
  }
  return out;
}

function historyItem(entry) {
  return {
    entry_id: entry.entry_id,
    ledger: entry.ledger,
    chain_id: entry.chain_id,
    wallet: String(entry.wallet).toLowerCase(),
    bot_id: entry.bot_id,
    outcome_code: entry.outcome_code,
    points: entry.points,
    status: entry.status,
    source_contract: String(entry.source_contract).toLowerCase(),
    event_names: entry.event_names,
    tx_hash: entry.tx_hash,
    log_index: entry.log_index,
    block_number: entry.block_number,
    block_hash: entry.block_hash,
    block_timestamp: entry.block_timestamp,
    escrow_id: entry.escrow_id,
    dispute_id: entry.dispute_id,
    rule_version: entry.rule_version,
    config_version: entry.config_version,
    cancel_reason: entry.cancel_reason,
    cancelled_by: entry.cancelled_by,
  };
}

function historyCmp(a, b) {
  if (a.block_number !== b.block_number) return b.block_number - a.block_number;
  const ai = a.log_index ?? Number.MAX_SAFE_INTEGER;
  const bi = b.log_index ?? Number.MAX_SAFE_INTEGER;
  if (ai !== bi) return bi - ai;
  return b.entry_id.localeCompare(a.entry_id);
}

function parseLimit(raw, latest) {
  if (raw === null || raw === "") return latest.read_api.history_page_default;
  if (!/^[0-9]+$/.test(raw)) throw httpError(400, "invalid_limit");
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > latest.read_api.history_page_max) {
    throw httpError(400, "invalid_limit");
  }
  return limit;
}

function parseCursor(raw) {
  if (raw === null || raw === "") return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    const logIndex = parsed.l === null ? null : parsed.l;
    if (!Number.isSafeInteger(parsed.b) || typeof parsed.e !== "string") return badCursor();
    if (logIndex !== null && !Number.isSafeInteger(logIndex)) return badCursor();
    return { b: parsed.b, l: logIndex, e: parsed.e };
  } catch (err) {
    if (err.error === "invalid_cursor") throw err;
    return badCursor();
  }
}

function badCursor() {
  throw httpError(400, "invalid_cursor");
}

function encodeCursor(entry) {
  return Buffer.from(
    JSON.stringify({ b: entry.block_number, l: entry.log_index, e: entry.entry_id }),
    "utf8",
  ).toString("base64url");
}

function assertCopy(text) {
  if (!text || BANNED_COPY.test(text)) throw httpError(500, "reputation_copy_rejected");
}
