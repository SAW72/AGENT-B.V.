/**
 * Checklist #7 stays fail closed: nothing is silently credited.
 * A clear screen stays unverified. It is not an approval.
 * Checklist #9 is still open. Design note v2.2 says O5_REPEAT and
 * DISPUTE_PREDATES_ESCROW go to the enforcer for review only and do not
 * auto-cancel or withhold points. An out-of-range Denylist bucket is the same:
 * DENYLIST_INVALID_BUCKET is review only and is not a Prompt listing.
 * PR #28's indexer stub returns eligible:true
 * for staging. This service does not.
 * See docs/reputation-ledger.md.
 */

import { decideSanctions, eligibilityFromDecision } from "../sanctions.mjs";

export function createDefaultEligibility(getScreen) {
  return function screen(input) {
    let snapshot = null;
    try {
      snapshot = typeof getScreen === "function" ? getScreen() : null;
    } catch {
      snapshot = null;
    }
    if (!snapshot) snapshot = { addresses: new Set(), persisted: new Set(), listReady: false };
    const decision = decideSanctions(input?.wallet, snapshot);
    const eligibility = eligibilityFromDecision(decision);
    return {
      eligible: false,
      status: eligibility.eligibility_status,
      points_withheld: true,
      reason: eligibility.eligibility_reason,
      provider: null,
    };
  };
}

export function createDefaultEnforcer() {
  const flags = [];
  return {
    flag(signal) {
      flags.push(signal);
      if (
        signal.kind === "O5_REPEAT" ||
        signal.kind === "DISPUTE_PREDATES_ESCROW" ||
        signal.kind === "DENYLIST_INVALID_BUCKET"
      ) {
        return { withhold_wallet: false, reason: "review_only" };
      }
      return { withhold_wallet: false, reason: "enforcer_unconfigured" };
    },
    flags() {
      return flags;
    },
  };
}

export function createDefaultHooks(options = {}) {
  return {
    eligibility: createDefaultEligibility(options.getScreen),
    enforcer: createDefaultEnforcer(),
  };
}

/** Test and staging override. Credits are still cap-limited. */
export function allowAllEligibility() {
  return function screen() {
    return { eligible: true, status: "eligible", points_withheld: false, reason: null, provider: "allow_all" };
  };
}

export function recordingEnforcer({ withholdOn = [] } = {}) {
  const kinds = new Set(withholdOn);
  const flags = [];
  return {
    flag(signal) {
      flags.push(signal);
      const withhold = kinds.has(signal.kind);
      return { withhold_wallet: withhold, reason: withhold ? signal.kind : null };
    },
    flags() {
      return flags;
    },
  };
}
