/**
 * Points-ledger checklist #9 hook.
 * The owner slot stays TBD until Spencer names one.
 * This module does not read the reputation enforcer owner.
 * Flags are review only. Nothing here cancels a row or writes negative points.
 */

export const POINTS_ENFORCER = Object.freeze({
  owner: "TBD",
  auto_cancel: false,
  flags: "review_only",
});

const REVIEW_ONLY = new Set([
  "O5_REPEAT",
  "DISPUTE_PREDATES_ESCROW",
  "DENYLIST_LISTED",
  "DENYLIST_UNLISTED",
  "BOT_BURNED",
  "PAIR_CAP",
  "OTHER",
]);

export function createPointsEnforcer() {
  const flags = [];
  return {
    owner: POINTS_ENFORCER.owner,
    autoCancel: false,
    flag(signal) {
      const kind = REVIEW_ONLY.has(signal?.kind) ? signal.kind : "OTHER";
      const recorded = {
        kind,
        wallet: signal?.wallet ?? null,
        bot_id: signal?.botId ?? signal?.bot_id ?? null,
        refs: Array.isArray(signal?.refs) ? signal.refs.map((ref) => String(ref)) : [],
        withhold_wallet: false,
        reason: "review_only",
        auto_cancel: false,
      };
      flags.push(recorded);
      return { withhold_wallet: false, reason: "review_only" };
    },
    flags() {
      return flags.map((flag) => ({ ...flag, refs: [...flag.refs] }));
    },
  };
}
