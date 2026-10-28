export function evaluateChain(...args: any[]): {
  accepted: boolean;
  terminalWallet?: string | null;
  reason?: string;
};
export function expiryAccepts(...args: any[]): boolean;
export function linkHash(...args: any[]): any;
export function recoverSigner(...args: any[]): { ok: boolean; reason?: string; address?: string };
