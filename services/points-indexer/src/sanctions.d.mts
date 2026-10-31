export const SDN_ADVANCED_URL: string;
export const SDN_HOST: string;
export const SANCTIONS_REFRESH_MS: number;
export const SANCTIONS_MAX_AGE_MS: number;
export const SANCTIONS_MIN_ADDRESSES: number;
export const SANCTIONS_MIN_KEEP_NUMERATOR: number;
export const SANCTIONS_MIN_KEEP_DENOMINATOR: number;
export const SANCTIONS_FETCH_TIMEOUT_MS: number;
export const SANCTIONS_MATCH: string;
export const SANCTIONS_UNAVAILABLE: string;
export const PUBLIC_DENIAL_MESSAGE: string;
export const SANCTIONS_CLEAR_RETENTION_MS: number;
export const SANCTIONS_MATCH_RETENTION_MS: number;
export const SANCTIONS_CHECKS_SQL: string;
export const SANCTIONS_MAX_BYTES: number;
export const SANCTIONS_MEMORY_MAX_BYTES: number;
export const SANCTIONS_RETAINED_MAX_BYTES: number;
export const SANCTIONS_MAX_ADDRESS_CHARS: number;
export const SANCTIONS_MAX_ADDRESSES: number;
export const SANCTIONS_MAX_TYPE_LABEL_CHARS: number;
export const SANCTIONS_MAX_FEATURE_TYPES: number;
export const SANCTIONS_MAX_TYPE_ID_CHARS: number;
export const SANCTIONS_ELEMENT_MAX_BYTES: number;
export const SANCTIONS_WINDOW_MAX_BYTES: number;
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
  listSha256: string | null;
  source: string | null;
  memo: Map<string, SanctionsDecision>;
  checkedAt: number;
};

export type SanctionsFetch = (
  input: string,
  init?: { redirect?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status?: number;
  type?: string;
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
  addressesSha256: string | null;
  rawSha256: string | null;
  fetchedAt: number | null;
};

export function normalizeSanctionsAddress(value: unknown): string;
export function walletHashHex(pepper: string, normalized: string): string | null;
export function canonicalAddressList(addresses: unknown): string[];
export function addressListSha256(addresses: unknown): string;
export function screenFromAddressList(addresses: unknown, now?: number, options?: {
  minAddresses?: number;
  maxAgeMs?: number;
  listVersion?: string;
  source?: string;
  rawSha256?: string;
  wallets?: unknown[];
}): SanctionsScreen;
export function decisionWithPepper(decision: SanctionsDecision, pepper: string): SanctionsDecision;
export function cacheIsFresh(fetchedAt: number, now: number, refreshMs?: number): boolean;
export function listWithinMaxAge(fetchedAt: number, now: number, maxAgeMs?: number): boolean;
export function parseSdnAdvancedXml(xml: string, options?: { minAddresses?: number }): { listVersion: string; addresses: string[] };
export function screenFromStored(
  cacheRow: any,
  walletRows: any,
  now?: number,
  options?: { minAddresses?: number; maxAgeMs?: number },
): SanctionsScreen;
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
export function sanctionsCheckParams(screen: SanctionsScreen, wallet: string, decision: SanctionsDecision, options?: {
  pepper?: string;
  chainId?: number | null;
  decisionPoint?: string | null;
}): {
  wallet: string;
  walletHash: string;
  result: string;
  reason: string;
  checkedAt: number;
  listVersion: string | null;
  listSha256: string | null;
  source: string | null;
  persisted: number;
  chainId: number | null;
  decisionPoint: string | null;
  storeWallet: boolean;
};
export function sanctionsCheckLog(screen: SanctionsScreen, wallet: string, decision: SanctionsDecision, options?: {
  pepper?: string;
}): {
  message: string;
  wallet_hash: string | null;
  result: string;
  reason: string;
  persisted: boolean;
  list_version: string | null;
  at: number;
};
export function fetchSdnAdvancedXml(
  fetchImpl: SanctionsFetch,
  url?: string,
  byteCap?: number,
  options?: { timeoutMs?: number },
): Promise<string>;
export function refreshParsedList(
  fetchImpl: SanctionsFetch,
  url: string,
  now: number,
  refreshMs: number,
  cacheRow: any,
  options?: { minAddresses?: number; timeoutMs?: number; byteCap?: number },
): Promise<SanctionsRefresh>;
export function swapSanctionsCache(db: {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: unknown[]): unknown };
}, params: {
  fetchedAt: number | null;
  source: string;
  listVersion: string | null;
  addressesJson: string;
  addressesSha256: string | null;
  rawSha256: string | null;
}): void;
export function migrateSanctionsSchema(db: {
  exec(sql: string): void;
  prepare(sql: string): { all(): Array<{ name: string }> };
}): void;
