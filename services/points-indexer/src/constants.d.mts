export const CHAIN_ID: number;
export const ESCROW: string;
export const PANEL: string;
export const ESCROW_START_BLOCK: number;
export const ACTION: {
  fund: string;
  releaseOrRefund: string;
  disputeOpenOrVote: string;
  firstActivity: string;
  returnDay: string;
};
export function isAcceptedChain(value: unknown): boolean;
