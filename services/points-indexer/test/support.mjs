import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encodeAbiParameters, pad } from "viem";
import { ACTION, ESCROW, PANEL, TOPIC } from "../src/constants.mjs";
import { openIndexer } from "../src/indexer.mjs";
import {
  DECISION_ENTRY_TYPES,
  POINTS_DOMAIN,
  POINTS_LINK_TYPES,
} from "../src/signature.mjs";

const ZERO = "0x0000000000000000000000000000000000000000";

export const LIVE = Object.freeze({
  escrow: ESCROW,
  panel: PANEL,
  payer: "0x6dbe4b1c56494ee00d6f97ffe9f853f42299d6ac",
  payee: "0x6c756dacfeceea12d5d39536d2ecc175f18bc5a4",
  voters: Object.freeze([
    "0xd5ee9fa366c3698b34204722c635989e5197b018",
    "0xf4253a3a3c102ee59e38b2aa92989c3232edcc30",
    "0xb87ed5f74276ac6172ef53fe866675093f75936e",
  ]),
  relayer: "0x9d1b3e1400d2632d435cb7c0fc131c4f42b31861",
  escrow1: "0xb59bc20615394ea19f212ebc51ba457710829ae197b8686fb2406b201a7a461b",
  escrow2: "0x00228e1f9dc268aedcd8a4b7e47672da25ab81695026faf50836a57a18806e17",
  dispute: "0x00fdbe7158c32437d415b2d6eeab8dd3683e45beabf3147d3ebe9642ed074dac",
  retired: "0x1069aa6597f08f1e8b8ad39aa40ede1d0c77298d",
  createBlock: 47938104,
  createLog: 1,
  disputeBlock: 47938201,
  disputeLog: 146,
  resolvedLog: 31,
  finalVoteLog: 32,
  releaseLog: 132,
  creditedLog: 133,
});

export function loadFixture() {
  const url = new URL("../fixtures/base-sepolia-logs.json", import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
}

export function account() {
  return privateKeyToAccount(generatePrivateKey());
}

export function tempIndexer(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "abv-points-"));
  const indexer = openIndexer({
    path: join(dir, "ledger.sqlite"),
    finalizedBlock: options.finalizedBlock ?? 100_000_000,
    ...options,
    walletHashPepper: options.walletHashPepper ?? "test-wallet-hash-pepper",
  });
  return {
    indexer,
    dir,
    close() {
      indexer.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function padAddress(address) {
  return pad(address, { size: 32 }).toLowerCase();
}

export function bytes32(n) {
  return `0x${BigInt(n).toString(16).padStart(64, "0")}`;
}

function swapPadded(hex, pairs) {
  let body = String(hex).toLowerCase().replace(/^0x/, "");
  for (const [from, to] of pairs) {
    const src = from.toLowerCase().replace(/^0x/, "").padStart(64, "0");
    const dst = to.toLowerCase().replace(/^0x/, "").padStart(64, "0");
    body = body.split(src).join(dst);
  }
  return `0x${body}`;
}

/** Copy recorded logs and swap event wallets for throwaway signers. tx.from is left as captured. */
export function rewriteEventWallets(logs, pairs) {
  return logs.map((log) => ({
    ...log,
    topics: log.topics.map((topic) => (topic == null ? topic : swapPadded(topic, pairs))),
    data: swapPadded(log.data, pairs),
  }));
}

export function upperLog(log) {
  return {
    ...log,
    address: String(log.address).toUpperCase(),
    transactionHash: String(log.transactionHash).toUpperCase(),
  };
}

export function makeLog({
  address,
  topics,
  data = "0x",
  blockNumber,
  logIndex,
  txHash,
  timestamp,
  removed = false,
  txFrom = null,
}) {
  return {
    address,
    topics,
    data,
    blockHash: bytes32(blockNumber + 1),
    blockNumber: `0x${blockNumber.toString(16)}`,
    blockTimestamp: `0x${timestamp.toString(16)}`,
    transactionHash: txHash,
    transactionIndex: "0x0",
    logIndex: `0x${logIndex.toString(16)}`,
    removed,
    transactionFrom: txFrom,
  };
}

export function createdLog({ escrowId, payer, payee, amount = 10n ** 15n, expiresAt, blockNumber, logIndex, txHash, timestamp, removed = false, txFrom = null }) {
  return makeLog({
    address: ESCROW,
    topics: [TOPIC.escrowCreated, escrowId, padAddress(payer), padAddress(payee)],
    data: encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" }],
      [bytes32(3), bytes32(4), amount, BigInt(expiresAt)],
    ),
    blockNumber,
    logIndex,
    txHash,
    timestamp,
    removed,
    txFrom,
  });
}

export function disputedLog({ escrowId, disputeId, party, blockNumber, logIndex, txHash, timestamp, address = ESCROW }) {
  return makeLog({
    address,
    topics: [TOPIC.escrowDisputed, escrowId],
    data: encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }],
      [disputeId, party],
    ),
    blockNumber,
    logIndex,
    txHash,
    timestamp,
  });
}

export function settlementLog({ kind, escrowId, amount = 10n ** 15n, blockNumber, logIndex, txHash, timestamp, txFrom = null }) {
  const topic = kind === "refund" ? TOPIC.escrowRefunded : TOPIC.escrowReleased;
  return makeLog({
    address: ESCROW,
    topics: [topic, escrowId],
    data: encodeAbiParameters([{ type: "uint256" }], [amount]),
    blockNumber,
    logIndex,
    txHash,
    timestamp,
    txFrom,
  });
}

export function voteLog({ disputeId, voter, support = true, blockNumber, logIndex, txHash, timestamp }) {
  return makeLog({
    address: PANEL,
    topics: [TOPIC.voteCast, disputeId],
    data: encodeAbiParameters(
      [{ type: "address" }, { type: "bool" }],
      [voter, support],
    ),
    blockNumber,
    logIndex,
    txHash,
    timestamp,
  });
}

export async function signedEntry(account, {
  actorType,
  authority,
  timestamp,
  modelVersion = "",
  scope = "escrow-action",
  accountableHumanId = ZERO,
}) {
  const message = {
    actorId: account.address,
    actorType,
    modelVersion,
    timestamp: BigInt(timestamp),
    scope,
    authority,
    accountableHumanId,
  };
  const signature = await account.signTypedData({
    domain: POINTS_DOMAIN,
    types: DECISION_ENTRY_TYPES,
    primaryType: "DecisionEntry",
    message,
  });
  return {
    actorId: account.address,
    actorType,
    modelVersion,
    timestamp,
    scope,
    authority,
    accountableHumanId,
    signature,
  };
}

export async function signLink(account, fields) {
  return account.signTypedData({
    domain: fields.domain ?? POINTS_DOMAIN,
    types: POINTS_LINK_TYPES,
    primaryType: "PointsLink",
    message: {
      escrowId: fields.escrowId,
      action: fields.action,
      txHash: fields.txHash,
      logIndex: BigInt(fields.logIndex),
      nonce: BigInt(fields.nonce),
      expiry: BigInt(fields.expiry),
      wallet: fields.wallet,
    },
  });
}

/**
 * Server origin, chain signed before the log, nonce, and PointsLink signed after it.
 * Throwaway keys only.
 */
export async function creditCandidate(indexer, signer, candidate, options = {}) {
  const terminal = candidate.blockTimestamp + (options.terminalOffset ?? -1);
  indexer.setOrigin(signer.address, {
    actorType: "human",
    identityAnchor: options.identityAnchor ?? true,
    behavioralSignals: options.behavioralSignals ?? true,
    modelVersion: "",
  });
  const entries = [];
  if (options.proposer) {
    indexer.setOrigin(options.proposer.address, {
      actorType: "ai",
      identityAnchor: false,
      behavioralSignals: false,
      modelVersion: "test-model",
    });
    entries.push(await signedEntry(options.proposer, {
      actorType: "ai",
      authority: "propose",
      timestamp: terminal - 1,
      modelVersion: "test-model",
    }));
  } else {
    entries.push(await signedEntry(signer, {
      actorType: "human",
      authority: "propose",
      timestamp: terminal - 1,
    }));
  }
  const approver = options.approver ?? signer;
  const approverType = options.approverType ?? "human";
  if (approver !== signer) {
    indexer.setOrigin(approver.address, {
      actorType: approverType,
      identityAnchor: approverType === "human",
      behavioralSignals: approverType === "human",
      modelVersion: approverType === "ai" ? "test-model" : "",
    });
  }
  entries.push(await signedEntry(approver, {
    actorType: approverType,
    authority: "approve",
    timestamp: terminal,
    modelVersion: approverType === "ai" ? "test-model" : "",
    accountableHumanId: options.accountableHumanId ?? ZERO,
  }));
  const chain = indexer.submitChain({
    wallet: candidate.wallet,
    action: candidate.action,
    escrowId: candidate.escrowId,
    entries,
  });
  const issueTime = candidate.blockTimestamp + (options.issueOffset ?? 3600);
  const issued = indexer.issueNonce({
    txHash: candidate.txHash,
    logIndex: candidate.logIndex,
    wallet: candidate.wallet,
    issueTime,
  });
  if (!issued.ok) return { chain, issued, link: null };
  const expiry = candidate.blockTimestamp + (options.expiryOffset ?? 60);
  const signature = await signLink(options.linkSigner ?? signer, {
    escrowId: candidate.escrowId,
    action: candidate.action,
    txHash: options.txHash ?? candidate.txHash,
    logIndex: options.logIndex ?? candidate.logIndex,
    nonce: issued.nonce,
    expiry,
    wallet: options.linkWallet ?? candidate.wallet,
    domain: options.domain,
  });
  const link = indexer.submitLink({
    nonce: issued.nonce,
    escrowId: options.escrowId ?? candidate.escrowId,
    action: options.action ?? candidate.action,
    txHash: options.txHash ?? candidate.txHash,
    logIndex: options.logIndex ?? candidate.logIndex,
    expiry,
    wallet: options.linkWallet ?? candidate.wallet,
    signature,
  });
  return { chain, issued, link };
}

export function rows(indexer, action = null) {
  const all = indexer.ledger();
  return action ? all.filter((row) => row.action === action) : all;
}

export function byRole(candidates, role) {
  return candidates.filter((candidate) => candidate.role === role);
}

export { ACTION, ZERO as ZERO_ADDRESS };
