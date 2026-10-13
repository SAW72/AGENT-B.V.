/** Base Sepolia only. Chain ids 1 and 8453 are refused. */
export const CHAIN_ID = 84532;
export const REFUSED_CHAIN_IDS = Object.freeze([1, 8453]);

export const ESCROW = "0x3d660502d75f1e97b08c110255921b437a3c4c42";
export const PANEL = "0x31a92f9a25396968e14d2b55b6b0bb1482ecf1bb";
export const ESCROW_START_BLOCK = 47715415;

export const RETIRED_ESCROWS = Object.freeze([
  "0x141214f04b0e1d949b6e6bf32d019ad7ab5b284c",
  "0x1069aa6597f08f1e8b8ad39aa40ede1d0c77298d",
]);

export const CLAIM_RELAYER = "0x9d1b3e1400d2632d435cb7c0fc131c4f42b31861";

export const TOPIC = Object.freeze({
  escrowCreated: "0x9d605e83d5554e0f88f697fe6184e9d0616163c141daf3ba689299e334a285c1",
  escrowReleased: "0x9410e7c5b50451e4b5bd5ce113fd48abebd7070eb9d080df08b115b7cdc41650",
  escrowRefunded: "0x21cabc2fff910e5afd1e2bcb22ff2b165a41ab0afbaf364f07aaf2f7787fb908",
  escrowDisputed: "0xe1be5dd4565e4e23afb935a6c3bb69e2179bf9404c41df9c70b9b7c1743a6cfe",
  escrowDisputedRetired: "0xcd4243485a48c9b2bc0e6ac4133f40bcac2bc94a0807c72c2dc2d60e023d2995",
  voteCast: "0x8b40665146691327ee30f5bf56e9b2d6f445d2830d3b09b56385cd30f630ecfb",
  disputeResolved: "0x6309d9f2499864a4f9d4ddb22f2b493afde8c215a1cd2e178647596cffe2efa4",
  disputeOpened: "0xff7eb321cb9f047b29ab55a1eaab2dbd40f73e1ec2b34cf847246a5ea1b0b535",
});

export const ACTION = Object.freeze({
  fund: "fund",
  releaseOrRefund: "release_or_refund",
  disputeOpenOrVote: "dispute_open_or_vote",
  firstActivity: "first_activity",
  returnDay: "return_day",
});

/** Chain-log actions. Derived rows are outside this set, so they do not collide on the log key. */
export const CHAIN_LOG_ACTIONS = Object.freeze([
  ACTION.fund,
  ACTION.releaseOrRefund,
  ACTION.disputeOpenOrVote,
]);

export const DAY_SECONDS = 86400;

export const DOMAIN_NAME = "Agent-BV Points";
export const DOMAIN_VERSION = "1";

export const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
export const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export function utcDay(blockTimestamp) {
  return Math.floor(Number(blockTimestamp) / DAY_SECONDS);
}

export function pairKey(payer, payee) {
  return [payer, payee].map((value) => value.toLowerCase()).sort().join(":");
}
