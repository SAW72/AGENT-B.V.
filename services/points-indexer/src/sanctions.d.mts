export const SDN_ADVANCED_URL: string;
export const SANCTIONS_REFRESH_MS: number;
export const SANCTIONS_MATCH: string;
export const SANCTIONS_MAX_BYTES: number;
export const SANCTIONS_SCHEMA_SQL: string[];
export const SANCTIONS_READ_CACHE: string;
export const SANCTIONS_WRITE_CACHE: string;
export const SANCTIONS_READ_WALLETS: string;
export const SANCTIONS_INSERT_WALLET: string;
export const SANCTIONS_INSERT_CHECK: string;

export type SanctionsDecision = {
  result: string;
  reason: string;
  persisted: boolean;
};

export type SanctionsScreen = {
  addresses: Set<string>;
  persisted: Set<string>;
  listReady: boolean;
  listVersion: string | null;
  source: string | null;
  memo: Map<string, SanctionsDecision>;
  checkedAt: number;
};

export type SanctionsFetch = (
  input: string,
  init?: { redirect?: string; headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  headers?: { get(name: string): string | null };
  text: () => Promise<string>;
  body?: {
    getReader?: () => {
      read: () => Promise<{ done: boolean; value?: Uint8Array }>;
      cancel: () => Promise<void>;
    };
  } | null;
}>;

export type SanctionsRefresh = {
  refreshed: boolean;
  failed: boolean;
  listVersion: string | null;
  count: number | null;
  addressesJson: string | null;
  fetchedAt: number | null;
};

export function normalizeSanctionsAddress(value: unknown): string;
export function cacheIsFresh(fetchedAt: number, now: number, refreshMs?: number): boolean;
export function parseSdnAdvancedXml(xml: string): { listVersion: string; addresses: string[] };
export function screenFromStored(cacheRow: any, walletRows: any, now?: number): SanctionsScreen;
export function decideSanctions(wallet: string, screen: {
  addresses?: Set<string>;
  persisted?: Set<string>;
  listReady?: boolean;
}): SanctionsDecision;
export function eligibilityFromDecision(decision: { result?: string }): {
  points: number;
  eligibility_status: string;
  eligibility_reason: string;
  points_withheld: number;
};
export function applySanctionsDecision(row: any, decision: SanctionsDecision): any;
export function noteDecision(screen: SanctionsScreen, wallet: string): { decision: SanctionsDecision; first: boolean };
export function forgetNotedDecision(screen: SanctionsScreen, wallet: string, decision: SanctionsDecision): void;
export function sanctionsCheckParams(screen: SanctionsScreen, wallet: string, decision: SanctionsDecision): {
  wallet: string;
  result: string;
  reason: string;
  checkedAt: number;
  listVersion: string | null;
  source: string | null;
  persisted: number;
  storeWallet: boolean;
};
export function sanctionsCheckLog(screen: SanctionsScreen, wallet: string, decision: SanctionsDecision): {
  message: string;
  wallet: string;
  result: string;
  reason: string;
  persisted: boolean;
  listVersion: string | null;
};
export function fetchSdnAdvancedXml(fetchImpl: SanctionsFetch, url?: string): Promise<string>;
export function refreshParsedList(
  fetchImpl: SanctionsFetch,
  url: string,
  now: number,
  refreshMs: number,
  cacheRow: any,
): Promise<SanctionsRefresh>;
