const KEYS = Object.freeze([
  "seq",
  "chain_id",
  "contract",
  "tx_hash",
  "log_index",
  "block_number",
  "block_timestamp",
  "utc_day",
  "wallet",
  "action",
  "escrow_id",
  "points",
  "eligibility_status",
  "eligibility_reason",
  "points_withheld",
  "rule_weight",
  "counts_for_return_day",
  "register_status",
  "dispute_id",
  "support",
  "source_action",
  "source_tx_hash",
  "source_log_index",
]);

const ACTION_ORDER = Object.freeze({
  fund: 1,
  release_or_refund: 2,
  dispute_open_or_vote: 3,
  first_activity: 4,
  return_day: 5,
});

export function compareRows(a, b) {
  return (
    a.block_number - b.block_number ||
    a.log_index - b.log_index ||
    (ACTION_ORDER[a.action] ?? 9) - (ACTION_ORDER[b.action] ?? 9) ||
    String(a.wallet).localeCompare(String(b.wallet)) ||
    String(a.source_action ?? "").localeCompare(String(b.source_action ?? ""))
  );
}

export function projectRow(row) {
  const out = {};
  for (const key of KEYS) {
    const value = row[key];
    out[key] = value === undefined ? null : value;
  }
  return out;
}

export function canonicalJson(rows) {
  return JSON.stringify(rows.map(projectRow));
}
