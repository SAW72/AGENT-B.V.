import { getAddress } from "viem";
import { encodeEventData } from "../reputation/codec.mjs";

export const VAULT = "0x1463D664fA467FBCDA4B05443434494f05e565bc";
export const ESCROW = "0x3d660502D75f1e97b08c110255921b437A3C4C42";
export const PANEL = "0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb";
export const DENYLIST = "0xeE76876bECcFc1B58fC06fF4E654a517d784B224";

/** First second of a UTC day, so day math does not depend on the local zone. */
export const DAY0 = 1_699_920_000;
export const BLOCK0 = 48_000_000;
export const FLOOR = 100_000_000_000_000n;

export function bytes32(n) {
  return `0x${BigInt(n).toString(16).padStart(64, "0")}`;
}

export function addr(byte) {
  return getAddress(`0x${byte.toString(16).padStart(2, "0").repeat(20)}`);
}

export function dayTs(day, offset = 0) {
  return DAY0 + day * 86400 + offset;
}

/** Stable logs for the Wallet UX example responses. Transaction hashes do not use the shared counter. */
export function walletUxSampleLogs() {
  const wallet = addr(0x11);
  const other = addr(0x22);
  const voter = addr(0x31);
  const bot = bytes32(1);
  const escrowId = bytes32(7);
  const disputeId = bytes32(8);
  const createdAt = dayTs(0, 0);
  const rows = [
    {
      event: "Registered",
      address: VAULT,
      args: { botId: bot, tier: 3, ts: BigInt(dayTs(1, 0)) },
      blockNumber: BLOCK0 + 1,
      logIndex: 0,
      timestamp: dayTs(1, 0),
    },
    {
      event: "OperatorSet",
      address: VAULT,
      args: { botId: bot, account: wallet },
      blockNumber: BLOCK0 + 1,
      logIndex: 1,
      timestamp: dayTs(1, 1),
    },
    {
      event: "EscrowCreated",
      address: ESCROW,
      args: {
        escrowId,
        payer: wallet,
        payee: other,
        payerBotId: bot,
        payeeBotId: bytes32(2),
        amount: 1n,
        expiresAt: BigInt(createdAt + 10),
      },
      blockNumber: BLOCK0 + 2,
      timestamp: createdAt,
    },
    {
      event: "DisputeOpened",
      address: PANEL,
      args: { disputeId, subjectHash: escrowId, challenger: other },
      blockNumber: BLOCK0 + 3,
      timestamp: dayTs(0, 1),
    },
    {
      event: "EscrowDisputed",
      address: ESCROW,
      args: { escrowId, disputeId },
      blockNumber: BLOCK0 + 4,
      timestamp: dayTs(0, 2),
    },
    {
      event: "VoteCast",
      address: PANEL,
      args: { disputeId, voter, support: true },
      blockNumber: BLOCK0 + 5,
      timestamp: dayTs(0, 3),
    },
    {
      event: "DisputeResolved",
      address: PANEL,
      args: { disputeId, upheld: true },
      blockNumber: BLOCK0 + 6,
      timestamp: dayTs(0, 4),
    },
    {
      event: "EscrowReleased",
      address: ESCROW,
      args: { escrowId, amount: 1n },
      blockNumber: BLOCK0 + 7,
      timestamp: dayTs(0, 5),
    },
  ];
  return rows.map((row, index) => businessLog({ ...row, tx: bytes32(0x7101 + index) }));
}

let seq = 1;

export function businessLog({
  event,
  args,
  address,
  blockNumber,
  logIndex = 0,
  timestamp,
  tx,
  blockHash,
  removed = false,
  chainId,
}) {
  seq += 1;
  const encoded = encodeEventData(event, args);
  return {
    address,
    ...encoded,
    blockNumber,
    logIndex,
    blockTimestamp: timestamp,
    transactionHash: tx || bytes32(0x5000 + seq),
    blockHash: blockHash || bytes32(0x6000n + BigInt(blockNumber) * 16n + BigInt(logIndex)),
    removed,
    ...(chainId !== undefined ? { chainId } : {}),
  };
}
