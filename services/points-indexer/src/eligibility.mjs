/**
 * Checklist #7 for the points read API.
 * The decision goes through the reputation eligibility hook, which calls the
 * public OFAC SDN screen and fail-closes. A clear wallet stays unverified.
 */

import { createDefaultEligibility } from "../../../claim-relayer/reputation/hooks.mjs";
import { SANCTIONS_MATCH, SANCTIONS_UNAVAILABLE, normalizeSanctionsAddress } from "./sanctions.mjs";

export function screenUnavailable() {
  return { addresses: new Set(), persisted: new Set(), listReady: false };
}

export function screenWithPersistedMatch(screen, wallet) {
  const persisted = new Set(screen?.persisted ?? []);
  const normalized = normalizeSanctionsAddress(wallet);
  if (normalized) persisted.add(normalized);
  return {
    addresses: screen?.addresses instanceof Set ? screen.addresses : new Set(),
    persisted,
    listReady: screen?.listReady === true,
  };
}

/**
 * @param {string | null | undefined} reason
 */
export function publicEligibility(reason) {
  if (reason === SANCTIONS_MATCH) return { status: "ineligible", reason: SANCTIONS_MATCH };
  if (reason === "unverified") return { status: "unverified", reason: "unverified" };
  return { status: "unverified", reason: SANCTIONS_UNAVAILABLE };
}

/**
 * @param {object | null | undefined} screen
 * @param {string} wallet
 */
export function addressEligibility(screen, wallet) {
  const hook = createDefaultEligibility(() => screen || screenUnavailable());
  const result = hook({ wallet });
  const view = publicEligibility(result?.reason);
  return {
    status: view.status,
    reason: view.reason,
    points_withheld: true,
    eligible: false,
  };
}
