import type { SanctionsScreen } from "./sanctions.mjs";

export type EligibilityView = {
  status: "ineligible" | "unverified";
  reason: string;
};

export type AddressEligibility = EligibilityView & {
  points_withheld: true;
  eligible: false;
};

// screenForRead's variable is SanctionsScreen, and the worker assigns these
// returns into it. Runtime fills addresses, persisted, and listReady.
export function screenUnavailable(): Omit<SanctionsScreen, "listReady"> & {
  listReady: false;
};

export function screenWithPersistedMatch(
  screen: {
    addresses?: unknown;
    persisted?: Iterable<string> | null;
    listReady?: boolean;
  } | null | undefined,
  wallet: string,
): SanctionsScreen;

export function publicEligibility(reason: string | null | undefined): EligibilityView;

export function addressEligibility(
  screen: SanctionsScreen | {
    addresses?: Set<string>;
    persisted?: Set<string>;
    listReady?: boolean;
  } | null | undefined,
  wallet: string,
): AddressEligibility;
