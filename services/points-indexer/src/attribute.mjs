import {
  ACTION,
  CHAIN_ID,
  ESCROW,
  ESCROW_START_BLOCK,
  PANEL,
  RETIRED_ESCROWS,
  TOPIC,
  isAcceptedChain,
  pairKey,
  utcDay,
} from "./constants.mjs";
import { PointsError, asBool, hexInt, lowerHex, wordAddress, wordsOf } from "./hex.mjs";

const RETIRED = new Set(RETIRED_ESCROWS);

function topic0(log) {
  return lowerHex(log.topics?.[0]);
}

function indexTopics(log) {
  return (log.topics || []).slice(1).map(lowerHex);
}

/**
 * Join escrow and panel logs into credit candidates.
 * This does not write the ledger and does not apply the decision-chain gate.
 * A candidate is not a committed row.
 */
export function attributeLogs(logs, { finalizedBlock, chainId = CHAIN_ID, includeUnfinalized = false } = {}) {
  if (!isAcceptedChain(chainId)) throw new PointsError("wrong_chain", { chainId });
  if (!Number.isInteger(finalizedBlock) || finalizedBlock < 0) throw new PointsError("bad_finalized");

  const skipped = [];
  const withheld = [];
  const decoded = [];

  for (const raw of logs) {
    let log;
    try {
      log = normalizeLog(raw);
    } catch (error) {
      skipped.push({ reason: error.reason || "unverifiable_log" });
      continue;
    }
    if (log.removed) {
      skipped.push({ reason: "removed", txHash: log.txHash, logIndex: log.logIndex });
      continue;
    }
    const finalized = log.blockNumber <= finalizedBlock;
    if (!finalized && !includeUnfinalized) {
      withheld.push({ reason: "not_finalized", txHash: log.txHash, logIndex: log.logIndex, blockNumber: log.blockNumber });
      continue;
    }
    const item = decodeOne(log);
    if (!item) {
      skipped.push({
        reason: skipReason(log),
        txHash: log.txHash,
        logIndex: log.logIndex,
        contract: log.contract,
      });
      continue;
    }
    item.finalized = finalized;
    decoded.push(item);
  }

  decoded.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);

  const escrows = new Map();
  const disputes = new Map();
  const ambiguousEscrows = new Set();
  const ambiguousDisputes = new Set();
  for (const item of decoded) {
    if (item.role === "fund") noteUnique(escrows, ambiguousEscrows, item.escrowId, item);
    if (item.role === "dispute_open") noteUnique(disputes, ambiguousDisputes, item.disputeId, item);
  }

  const candidates = [];
  const deferred = [];
  for (const item of decoded) {
    if (item.role === "fund" || item.role === "dispute_open") {
      const ambiguous = item.role === "fund"
        ? ambiguousEscrows.has(item.escrowId)
        : ambiguousDisputes.has(item.disputeId);
      if (ambiguous) {
        skipped.push({
          reason: item.role === "fund" ? "ambiguous_escrow" : "ambiguous_dispute",
          txHash: item.txHash,
          logIndex: item.logIndex,
        });
        continue;
      }
      candidates.push(toCandidate(item, item.wallet, item.escrowId));
      continue;
    }
    if (item.role === "release" || item.role === "refund") {
      if (ambiguousEscrows.has(item.escrowId)) {
        skipped.push({ reason: "ambiguous_escrow", txHash: item.txHash, logIndex: item.logIndex });
        continue;
      }
      const created = escrows.get(item.escrowId);
      if (!created) {
        deferred.push({ ...item, reason: "create_not_stored" });
        continue;
      }
      const wallet = item.role === "release" ? created.payee : created.payer;
      candidates.push(toCandidate(item, wallet, item.escrowId, created));
      continue;
    }
    if (item.role === "vote") {
      if (ambiguousDisputes.has(item.disputeId)) {
        skipped.push({ reason: "ambiguous_dispute", txHash: item.txHash, logIndex: item.logIndex });
        continue;
      }
      const dispute = disputes.get(item.disputeId);
      if (!dispute) {
        deferred.push({ ...item, reason: "dispute_not_stored" });
        continue;
      }
      if (ambiguousEscrows.has(dispute.escrowId)) {
        skipped.push({ reason: "ambiguous_escrow", txHash: item.txHash, logIndex: item.logIndex });
        continue;
      }
      const created = escrows.get(dispute.escrowId);
      if (created && (item.voter === created.payer || item.voter === created.payee)) {
        skipped.push({
          reason: "voter_is_party",
          txHash: item.txHash,
          logIndex: item.logIndex,
          wallet: item.voter,
        });
        continue;
      }
      candidates.push(toCandidate(item, item.voter, dispute.escrowId, created, dispute));
    }
  }

  return { candidates, deferred, skipped, withheld, escrows, disputes };
}

function noteUnique(map, ambiguous, key, item) {
  if (ambiguous.has(key) || map.has(key)) {
    map.delete(key);
    ambiguous.add(key);
    return;
  }
  map.set(key, item);
}

function toCandidate(item, wallet, escrowId, created = null, dispute = null) {
  const create = item.role === "fund" ? item : created;
  return {
    chainId: CHAIN_ID,
    contract: item.contract,
    txHash: item.txHash,
    logIndex: item.logIndex,
    blockNumber: item.blockNumber,
    blockTimestamp: item.blockTimestamp,
    utcDay: utcDay(item.blockTimestamp),
    wallet,
    action: item.action,
    role: item.role,
    escrowId,
    disputeId: item.disputeId ?? dispute?.disputeId ?? null,
    support: item.support ?? null,
    txFrom: item.txFrom,
    finalized: item.finalized,
    payer: create?.payer ?? null,
    payee: create?.payee ?? null,
    amount: create?.amount ?? item.amount ?? null,
    expiresAt: create?.expiresAt ?? null,
    createTimestamp: create?.blockTimestamp ?? null,
    pair: create ? pairKey(create.payer, create.payee) : null,
  };
}

export function normalizeLog(raw) {
  if (!raw || typeof raw !== "object") throw new PointsError("unverifiable_log");
  const contract = lowerHex(raw.address);
  const txHash = lowerHex(raw.transactionHash);
  const blockHash = lowerHex(raw.blockHash);
  if (!contract || !/^0x[0-9a-f]{40}$/.test(contract)) throw new PointsError("unverifiable_log");
  if (!txHash || !/^0x[0-9a-f]{64}$/.test(txHash)) throw new PointsError("unverifiable_log");
  if (!blockHash || !/^0x[0-9a-f]{64}$/.test(blockHash)) throw new PointsError("unverifiable_log");
  if (!Array.isArray(raw.topics) || raw.topics.length === 0) throw new PointsError("unverifiable_log");
  const data = lowerHex(raw.data);
  if (data === null || !/^0x([0-9a-f]{2})*$/.test(data)) throw new PointsError("unverifiable_log");
  let blockNumber;
  let logIndex;
  let blockTimestamp;
  try {
    blockNumber = hexInt(raw.blockNumber);
    logIndex = hexInt(raw.logIndex);
    blockTimestamp = hexInt(raw.blockTimestamp);
  } catch {
    throw new PointsError("unverifiable_log");
  }
  return {
    contract,
    txHash,
    blockHash,
    blockNumber,
    logIndex,
    blockTimestamp,
    topics: raw.topics.map(lowerHex),
    data,
    removed: asBool(raw.removed),
    txFrom: raw.transactionFrom ? lowerHex(raw.transactionFrom) : null,
  };
}

function decodeOne(log) {
  const topic = topic0(log);
  if (log.contract === ESCROW) {
    if (log.blockNumber < ESCROW_START_BLOCK) return null;
    if (topic === TOPIC.escrowCreated) return decodeCreated(log);
    if (topic === TOPIC.escrowReleased) return decodeSettlement(log, "release");
    if (topic === TOPIC.escrowRefunded) return decodeSettlement(log, "refund");
    if (topic === TOPIC.escrowDisputed) return decodeDisputed(log);
    return null;
  }
  if (log.contract === PANEL) {
    if (topic === TOPIC.voteCast) return decodeVote(log);
    return null;
  }
  return null;
}

function skipReason(log) {
  const topic = topic0(log);
  if (RETIRED.has(log.contract)) return "retired_escrow";
  if (log.contract === ESCROW && log.blockNumber < ESCROW_START_BLOCK) return "start_block";
  if (topic === TOPIC.escrowDisputedRetired) return "retired_dispute_shape";
  if (log.contract !== ESCROW && log.contract !== PANEL) return "contract";
  return "not_points_event";
}

function decodeCreated(log) {
  const topics = indexTopics(log);
  const data = wordsOf(log.data);
  if (topics.length < 3 || data.length < 4) return null;
  const payer = wordAddress(topics[1]);
  const payee = wordAddress(topics[2]);
  if (!payer || !payee) return null;
  return base(log, {
    role: "fund",
    action: ACTION.fund,
    wallet: payer,
    escrowId: topics[0],
    payer,
    payee,
    amount: BigInt(data[2]).toString(),
    expiresAt: Number(BigInt(data[3])),
  });
}

function decodeSettlement(log, role) {
  const topics = indexTopics(log);
  if (topics.length < 1) return null;
  return base(log, {
    role,
    action: ACTION.releaseOrRefund,
    escrowId: topics[0],
    wallet: null,
  });
}

function decodeDisputed(log) {
  const topics = indexTopics(log);
  const data = wordsOf(log.data);
  if (topics.length < 1 || data.length < 2) return null;
  const party = wordAddress(data[1]);
  if (!party) return null;
  return base(log, {
    role: "dispute_open",
    action: ACTION.disputeOpenOrVote,
    escrowId: topics[0],
    disputeId: data[0],
    wallet: party,
    party,
  });
}

function decodeVote(log) {
  const topics = indexTopics(log);
  const data = wordsOf(log.data);
  if (topics.length < 1 || data.length < 2) return null;
  const voter = wordAddress(data[0]);
  if (!voter) return null;
  return base(log, {
    role: "vote",
    action: ACTION.disputeOpenOrVote,
    disputeId: topics[0],
    voter,
    wallet: voter,
    support: Number(BigInt(data[1])) === 1 ? 1 : 0,
  });
}

function base(log, fields) {
  return {
    contract: log.contract,
    txHash: log.txHash,
    logIndex: log.logIndex,
    blockNumber: log.blockNumber,
    blockTimestamp: log.blockTimestamp,
    txFrom: log.txFrom,
    ...fields,
  };
}
