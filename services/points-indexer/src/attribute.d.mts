export function attributeLogs(logs: unknown, options: {
  finalizedBlock?: number;
  chainId?: number;
  includeUnfinalized?: boolean;
}): { candidates: any[] };
export function normalizeLog(log: unknown): any;
