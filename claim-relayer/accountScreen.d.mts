export function doSql(sql: {
  exec(statement: string, ...params: unknown[]): { toArray(): unknown[] };
}): {
  exec(statement: string): void;
  get(statement: string, ...params: unknown[]): unknown;
  all(statement: string, ...params: unknown[]): unknown[];
  run(statement: string, ...params: unknown[]): unknown;
};

export function purgeRetention(
  sql: ReturnType<typeof doSql>,
  now: number,
): {
  cleared: number;
  unavailable: number;
  matches: number;
  blocks: number;
  disputes: number;
  at: number;
};

export function rescreenLinkedWallets(
  sql: ReturnType<typeof doSql>,
  screen: unknown,
  input?: { pepper?: string; now?: number; chainId?: number },
): Promise<unknown>;

export const PUBLIC_DENIAL_MESSAGE: string;
export const SANCTIONS_CLEAR_RETENTION_MS: number;
export const SANCTIONS_MATCH_RETENTION_MS: number;
