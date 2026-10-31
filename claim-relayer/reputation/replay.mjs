import { getAddress } from "viem";
import { httpError } from "../config.mjs";
import { denylistBucketName, denylistBucketOrdinal } from "../denylistBucket.mjs";
import { decodeBusinessLog } from "./codec.mjs";
import { createDefaultHooks } from "./hooks.mjs";
import {
  ARBITRATOR_LEDGER,
  USAGE_LEDGER,
  loadReputationConfig,
  validateAdjustments,
  versionAt,
} from "./reputationConfig.mjs";

const ZERO = "0x0000000000000000000000000000000000000000";
const ZERO_HASH = `0x${"0".repeat(64)}`;
const ROLE_RANK = { operator: 0, payer: 1, payee: 2, challenger: 3, arbitrator: 4, adjustment: 5 };
const OUTCOME_RANK = { signal: 0, O1: 1, O2: 2, O3: 3, O4: 4, O5: 5, A1: 6, A2: 7, ADJ: 8 };

export function refuseReputationChain(chainId) {
  const id = Number(chainId);
  if (id === 1 || id === 8453) throw httpError(400, "mainnet_refused", { chainId: id });
  if (!Number.isInteger(id) || id !== 84532) throw httpError(400, "wrong_chain", { chainId });
  return id;
}

export function utcDay(timestamp) {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw httpError(400, "invalid_block_timestamp");
  }
  return Math.floor(timestamp / 86400);
}

/** Season id for a completing log. Null means the season cap does not apply. */
export function seasonKey(version, log) {
  const season = version?.season;
  if (!season || season.start_block === null || season.start_timestamp === null) return null;
  if (!Number.isSafeInteger(season.length_days) || season.length_days < 1) return null;
  if (log.blockNumber < season.start_block) return null;
  const span = season.length_days * 86400;
  const delta = log.blockTimestamp - season.start_timestamp;
  if (delta < 0) return null;
  return `season-${Math.floor(delta / span) + 1}`;
}

function asInt(value, field) {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "bigint") {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw httpError(400, "invalid_log_field", { field });
    return Number(value);
  }
  if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) return asInt(BigInt(value), field);
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return asInt(Number(value), field);
  throw httpError(400, "invalid_log_field", { field });
}

function asHash(value, field) {
  const hex = String(value || "");
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw httpError(400, "invalid_log_field", { field });
  return hex.toLowerCase();
}

function asBytes32(value, field) {
  const hex = String(value || "");
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw httpError(400, "invalid_log_field", { field });
  return hex.toLowerCase();
}

function asAddress(value, field) {
  try {
    return getAddress(String(value));
  } catch {
    throw httpError(400, "invalid_log_field", { field });
  }
}

function cmpLog(a, b) {
  if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
  return a.logIndex - b.logIndex;
}

function later(logs) {
  return logs.reduce((best, log) => (cmpLog(log, best) > 0 ? log : best));
}

/**
 * Pure ledger. Same logs, config, adjustments, hooks, and head produce the same entries.
 * @param {object} input
 */
export function replayLedger(input = {}) {
  refuseReputationChain(input.chainId ?? 84532);
  const loaded = input.versions ? null : loadReputationConfig();
  const versions = (input.versions || loaded.versions).slice().sort((a, b) => a.effective_from_block - b.effective_from_block);
  const adjustments = input.adjustments
    ? validateAdjustments(input.adjustments)
    : input.versions
      ? []
      : loaded.adjustments;
  const hooks = input.hooks || createDefaultHooks(input);
  const logs = Array.isArray(input.logs) ? input.logs : [];
  const hasWork = logs.length > 0 || adjustments.length > 0;
  const head = resolveHead(input, hasWork);

  const kept = [];
  for (const raw of logs) {
    if (raw && raw.chainId !== undefined && raw.chainId !== null) refuseReputationChain(raw.chainId);
    if (raw?.removed === true) continue;
    const item = normalizeLog(raw, versions);
    if (!item) continue;
    if (head.safeBlock !== null && item.blockNumber > head.safeBlock) continue;
    kept.push(item);
  }
  kept.sort(cmpLog);

  const seenRaw = new Set();
  const unique = [];
  for (const item of kept) {
    const key = `${item.blockHash}:${item.logIndex}:${item.addressLower}`;
    if (seenRaw.has(key)) continue;
    seenRaw.add(key);
    unique.push(item);
  }

  const state = fold(unique);
  const candidates = derive(state, versions, head);
  for (const row of adjustments) {
    if (head.safeBlock !== null && row.effective_block > head.safeBlock) continue;
    candidates.push(adjustmentCandidate(row, versions, head));
  }
  candidates.sort(compareCandidate);

  const { entries, signals, enforcerFlags } = materialize(candidates, hooks, head);
  entries.sort(compareEntry);
  const newest = unique.length ? unique[unique.length - 1] : null;
  return {
    chain_id: 84532,
    usage_ledger: USAGE_LEDGER,
    arbitrator_ledger: ARBITRATOR_LEDGER,
    entries,
    signals,
    enforcer_flags: enforcerFlags,
    head: {
      safe_block: head.safeBlock,
      finalized_block: head.finalizedBlock,
      indexed_to_block: head.safeBlock,
      indexed_to_block_timestamp: head.safeBlock === null || !newest ? null : newest.blockTimestamp,
    },
  };
}

export function canonicalJson(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortJson(value[key]);
    return out;
  }
  return value;
}

function resolveHead(input, hasWork) {
  if (!hasWork) {
    return { safeBlock: input.safeBlock ?? null, finalizedBlock: input.finalizedBlock ?? null };
  }
  if (!Number.isSafeInteger(input.safeBlock) || !Number.isSafeInteger(input.finalizedBlock)) {
    throw httpError(400, "head_required");
  }
  if (input.finalizedBlock > input.safeBlock) throw httpError(400, "invalid_head");
  return { safeBlock: input.safeBlock, finalizedBlock: input.finalizedBlock };
}

function normalizeLog(raw, versions) {
  if (!raw || !Array.isArray(raw.topics)) return null;
  const decoded = decodeBusinessLog(raw);
  if (!decoded) return null;
  const blockNumber = asInt(raw.blockNumber, "blockNumber");
  const version = versionAt(versions, blockNumber);
  if (!version) throw httpError(400, "no_config_version", { blockNumber });
  const slot = version.contracts[decoded.contract];
  const address = asAddress(raw.address, "address");
  if (address.toLowerCase() !== slot.address_lower) return null;
  if (blockNumber < slot.start_block) return null;
  const log = {
    name: decoded.name,
    contract: decoded.contract,
    args: decoded.args,
    address,
    addressLower: address.toLowerCase(),
    blockNumber,
    logIndex: asInt(raw.logIndex, "logIndex"),
    blockHash: asHash(raw.blockHash, "blockHash"),
    txHash: asHash(raw.transactionHash || raw.txHash, "txHash"),
    blockTimestamp: asInt(raw.blockTimestamp ?? raw.block_timestamp, "blockTimestamp"),
  };
  return log;
}

function fold(logs) {
  const state = {
    bots: new Map(),
    burns: [],
    escrows: new Map(),
    disputes: new Map(),
    denylist: [],
  };
  for (const log of logs) {
    if (log.name === "Registered") addRegistered(state, log);
    else if (log.name === "OperatorSet") addOperator(state, log);
    else if (log.name === "Burned") state.burns.push({ botId: asBytes32(log.args.botId, "botId"), log });
    else if (log.name === "EscrowCreated") addCreated(state, log);
    else if (log.name === "EscrowReleased" || log.name === "EscrowRefunded") addTerminal(state, log);
    else if (log.name === "EscrowDisputed") addDisputed(state, log);
    else if (log.name === "DisputeOpened") addOpened(state, log);
    else if (log.name === "VoteCast") addVote(state, log);
    else if (log.name === "DisputeResolved") addResolved(state, log);
    else if (log.name === "Listed" || log.name === "Unlisted") state.denylist.push(log);
  }
  return state;
}

function botRecord(state, botId) {
  const bot = state.bots.get(botId) || { sets: [], registrations: [] };
  bot.sets = bot.sets || [];
  bot.registrations = bot.registrations || [];
  return bot;
}

function addRegistered(state, log) {
  const botId = asBytes32(log.args.botId, "botId");
  const tier = asInt(log.args.tier, "tier");
  const bot = botRecord(state, botId);
  const idx = bot.registrations.findIndex((row) => row.log.txHash === log.txHash);
  if (idx >= 0) {
    if (bot.registrations[idx].log.blockHash !== log.blockHash && cmpLog(log, bot.registrations[idx].log) > 0) {
      bot.registrations[idx] = { tier, log };
    }
  } else {
    bot.registrations.push({ tier, log });
  }
  bot.registrations.sort((a, b) => cmpLog(a.log, b.log));
  state.bots.set(botId, bot);
}

function addOperator(state, log) {
  const botId = asBytes32(log.args.botId, "botId");
  const account = asAddress(log.args.account, "account");
  if (account.toLowerCase() === ZERO) return;
  const bot = botRecord(state, botId);
  const idx = bot.sets.findIndex((row) => row.log.txHash === log.txHash);
  if (idx >= 0) {
    if (bot.sets[idx].log.blockHash !== log.blockHash && cmpLog(log, bot.sets[idx].log) > 0) {
      bot.sets[idx] = { account, log };
    }
  } else {
    bot.sets.push({ account, log });
  }
  bot.sets.sort((a, b) => cmpLog(a.log, b.log));
  state.bots.set(botId, bot);
}

function replaceEarlier(prev, log) {
  if (!prev) return "set";
  if (prev.log.blockHash === log.blockHash && prev.log.logIndex === log.logIndex) return "skip";
  if (prev.log.txHash === log.txHash && prev.log.blockHash !== log.blockHash) {
    return cmpLog(log, prev.log) > 0 ? "set" : "skip";
  }
  return cmpLog(log, prev.log) < 0 ? "set" : "skip";
}

function addCreated(state, log) {
  const escrowId = asBytes32(log.args.escrowId, "escrowId");
  const prev = state.escrows.get(escrowId);
  const decision = replaceEarlier(prev?.createdLog ? { log: prev.createdLog } : null, log);
  if (decision === "skip" && prev) return;
  const row = prev || {};
  row.escrowId = escrowId;
  row.payer = asAddress(log.args.payer, "payer");
  row.payee = asAddress(log.args.payee, "payee");
  row.payerBotId = asBytes32(log.args.payerBotId, "payerBotId");
  row.payeeBotId = asBytes32(log.args.payeeBotId, "payeeBotId");
  row.amount = BigInt(log.args.amount);
  row.expiresAt = asInt(log.args.expiresAt, "expiresAt");
  row.createdLog = log;
  state.escrows.set(escrowId, row);
}

function addTerminal(state, log) {
  const escrowId = asBytes32(log.args.escrowId, "escrowId");
  const row = state.escrows.get(escrowId) || { escrowId };
  const next = { kind: log.name, log, amount: BigInt(log.args.amount) };
  const decision = replaceEarlier(row.terminal ? { log: row.terminal.log } : null, log);
  if (decision === "set") row.terminal = next;
  state.escrows.set(escrowId, row);
}

function addDisputed(state, log) {
  const escrowId = asBytes32(log.args.escrowId, "escrowId");
  const row = state.escrows.get(escrowId) || { escrowId };
  const disputeId = asBytes32(log.args.disputeId, "disputeId");
  const decision = replaceEarlier(row.disputedLog ? { log: row.disputedLog } : null, log);
  if (decision === "set") {
    row.disputedLog = log;
    row.disputeId = disputeId;
  }
  state.escrows.set(escrowId, row);
}

function addOpened(state, log) {
  const disputeId = asBytes32(log.args.disputeId, "disputeId");
  const row = state.disputes.get(disputeId) || { disputeId, votes: [] };
  const decision = replaceEarlier(row.openedLog ? { log: row.openedLog } : null, log);
  if (decision === "set") {
    row.subjectHash = asBytes32(log.args.subjectHash, "subjectHash");
    row.challenger = asAddress(log.args.challenger, "challenger");
    row.openedLog = log;
  }
  state.disputes.set(disputeId, row);
}

function addVote(state, log) {
  const disputeId = asBytes32(log.args.disputeId, "disputeId");
  const row = state.disputes.get(disputeId) || { disputeId, votes: [] };
  const voter = asAddress(log.args.voter, "voter");
  const support = Boolean(log.args.support);
  const idx = row.votes.findIndex((vote) => vote.voter.toLowerCase() === voter.toLowerCase());
  if (idx >= 0) {
    const decision = replaceEarlier({ log: row.votes[idx].log }, log);
    if (decision === "set") row.votes[idx] = { voter, support, log };
  } else {
    row.votes.push({ voter, support, log });
  }
  row.votes.sort((a, b) => cmpLog(a.log, b.log));
  state.disputes.set(disputeId, row);
}

function addResolved(state, log) {
  const disputeId = asBytes32(log.args.disputeId, "disputeId");
  const row = state.disputes.get(disputeId) || { disputeId, votes: [] };
  const decision = replaceEarlier(row.resolvedLog ? { log: row.resolvedLog } : null, log);
  if (decision === "set") {
    row.resolvedLog = log;
    row.upheld = Boolean(log.args.upheld);
  }
  state.disputes.set(disputeId, row);
}

function statusFor(logs, head) {
  if (logs.some((log) => head.safeBlock !== null && log.blockNumber > head.safeBlock)) return null;
  if (head.finalizedBlock === null) return "provisional";
  return logs.every((log) => log.blockNumber <= head.finalizedBlock) ? "final" : "provisional";
}

function named(parts) {
  return parts
    .slice()
    .sort((a, b) => cmpLog(a.log, b.log))
    .map((part) => part.name);
}

function baseEntry(fields) {
  return {
    outcome_code: fields.outcome,
    nominal_points: fields.nominal,
    ledger: fields.ledger,
    wallet: fields.wallet,
    bot_id: fields.botId,
    role: fields.role,
    semantic_key: fields.semanticKey,
    entry_id: fields.entryId,
    escrow_id: fields.escrowId,
    dispute_id: fields.disputeId,
    sourceLogs: fields.sourceLogs,
    completing: fields.completing,
    event_names: named(fields.parts),
    rule_version: fields.version.rule_version,
    config_version: fields.version.config_version,
    season_id: seasonKey(fields.version, fields.completing),
    day: utcDay(fields.completing.blockTimestamp),
    pairKey: fields.pairKey || null,
    version: fields.version,
  };
}

function derive(state, versions, head) {
  const candidates = [];
  for (const [botId, bot] of state.bots) {
    const first = bot.sets[0];
    if (!first) continue;
    const version = requireVersion(versions, first.log.blockNumber);
    const status = statusFor([first.log], head);
    if (!status) continue;
    const wallet = first.account;
    const tier = tierAt(bot, first.log);
    const tierOk = !version.gates.o1_tier_enabled || (tier !== null && tier >= version.gates.o1_min_tier);
    const burnedBefore = state.burns.some(
      (burn) => burn.botId === botId && burn.log.blockNumber <= first.log.blockNumber,
    );
    candidates.push({
      ...baseEntry({
        outcome: "O1",
        nominal: version.points.O1,
        ledger: USAGE_LEDGER,
        wallet,
        botId,
        role: "operator",
        semanticKey: `O1:${botId}`,
        entryId: `O1:${botId}`,
        escrowId: null,
        disputeId: null,
        sourceLogs: [first.log],
        completing: first.log,
        parts: [{ name: "OperatorSet", log: first.log }],
        version,
      }),
      status,
      o1TierOk: tierOk,
      o1BurnedBefore: burnedBefore,
    });
  }

  for (const burn of state.burns) {
    candidates.push({
      outcome_code: "signal",
      signal: {
        kind: "BOT_BURNED",
        wallet: null,
        bot_id: burn.botId,
        block_number: burn.log.blockNumber,
        refs: [burn.botId],
      },
      completing: burn.log,
      entry_id: `signal:burn:${burn.botId}:${burn.log.blockHash}`,
      role: "operator",
    });
  }

  for (const log of state.denylist) {
    const id = asBytes32(log.args.id, "id");
    const actor = asAddress(log.args.actor, "actor");
    const bucketName = denylistBucketName(log.args.bucket);
    if (!bucketName) {
      const raw = denylistBucketOrdinal(log.args.bucket);
      candidates.push({
        outcome_code: "signal",
        forceNoWithhold: true,
        signal: {
          kind: "DENYLIST_INVALID_BUCKET",
          wallet: null,
          bot_id: null,
          block_number: log.blockNumber,
          refs: [id],
          bucket: raw,
        },
        completing: log,
        entry_id: `signal:invalid-bucket:${log.name}:${id}:${raw}:${log.blockHash}`,
        role: "operator",
      });
      continue;
    }
    candidates.push({
      outcome_code: "signal",
      signal: {
        kind: log.name === "Listed" ? "DENYLIST_LISTED" : "DENYLIST_UNLISTED",
        wallet: actor,
        bot_id: null,
        block_number: log.blockNumber,
        refs: [id],
      },
      completing: log,
      entry_id: `signal:${log.name}:${id}:${log.blockHash}`,
      role: "operator",
    });
  }

  const escrowByDispute = new Map();
  for (const escrow of state.escrows.values()) {
    if (escrow.disputeId) escrowByDispute.set(escrow.disputeId, escrow);
  }

  for (const escrow of state.escrows.values()) {
    if (!escrow.createdLog) continue;
    const disputed = Boolean(escrow.disputedLog);
    const released = escrow.terminal?.kind === "EscrowReleased";
    const refunded = escrow.terminal?.kind === "EscrowRefunded";
    if (released && !disputed) pushO2(candidates, escrow, versions, head);
    if (refunded && !disputed) pushO3(candidates, escrow, versions, head);
    if (disputed && (released || refunded)) pushO4(candidates, escrow, state, versions, head);
  }

  for (const dispute of state.disputes.values()) {
    if (!dispute.openedLog) continue;
    const linked = escrowByDispute.get(dispute.disputeId);
    const linkedHere = linked && linked.disputeId === dispute.disputeId && linked.disputedLog;
    if (linkedHere) continue;
    const subject = state.escrows.get(dispute.subjectHash);
    if (subject && !subject.terminal) continue;
    pushO5(candidates, dispute, subject, versions, head);
  }

  for (const dispute of state.disputes.values()) {
    const escrow = escrowByDispute.get(dispute.disputeId);
    if (!escrow?.disputedLog || !dispute.resolvedLog) continue;
    for (const vote of dispute.votes) pushVote(candidates, dispute, escrow, vote, versions, head);
  }
  return candidates;
}

function pushO2(candidates, escrow, versions, head) {
  const completing = later([escrow.createdLog, escrow.terminal.log]);
  const version = requireVersion(versions, completing.blockNumber);
  const elapsed = escrow.terminal.log.blockTimestamp - escrow.createdLog.blockTimestamp;
  if (escrow.amount < version.floors.min_amount_wei) return;
  if (elapsed < version.floors.o2_seconds) return;
  const status = statusFor([escrow.createdLog, escrow.terminal.log], head);
  if (!status) return;
  const parts = [
    { name: "EscrowCreated", log: escrow.createdLog },
    { name: "EscrowReleased", log: escrow.terminal.log },
  ];
  const pairKey = pairOf(escrow);
  for (const role of ["payer", "payee"]) {
    const wallet = escrow[role];
    const botId = role === "payer" ? escrow.payerBotId : escrow.payeeBotId;
    const nominal = role === "payer" ? version.points.O2_payer : version.points.O2_payee;
    if (nominal === 0) continue;
    candidates.push({
      ...baseEntry({
        outcome: "O2",
        nominal,
        ledger: USAGE_LEDGER,
        wallet,
        botId,
        role,
        semanticKey: `O2:${escrow.escrowId}`,
        entryId: `O2:${escrow.escrowId}:${wallet.toLowerCase()}`,
        escrowId: escrow.escrowId,
        disputeId: null,
        sourceLogs: [escrow.createdLog, escrow.terminal.log],
        completing,
        parts,
        version,
        pairKey,
      }),
      status,
    });
  }
}

function pushO3(candidates, escrow, versions, head) {
  const completing = later([escrow.createdLog, escrow.terminal.log]);
  const version = requireVersion(versions, completing.blockNumber);
  const setDuration = escrow.expiresAt - escrow.createdLog.blockTimestamp;
  if (escrow.amount < version.floors.min_amount_wei) return;
  if (setDuration < version.floors.o3_seconds) return;
  const status = statusFor([escrow.createdLog, escrow.terminal.log], head);
  if (!status) return;
  const parts = [
    { name: "EscrowCreated", log: escrow.createdLog },
    { name: "EscrowRefunded", log: escrow.terminal.log },
  ];
  const rows = [
    ["payer", escrow.payer, escrow.payerBotId, version.points.O3_payer],
    ["payee", escrow.payee, escrow.payeeBotId, version.points.O3_payee],
  ];
  for (const [role, wallet, botId, nominal] of rows) {
    if (nominal === 0) continue;
    candidates.push({
      ...baseEntry({
        outcome: "O3",
        nominal,
        ledger: USAGE_LEDGER,
        wallet,
        botId,
        role,
        semanticKey: `O3:${escrow.escrowId}`,
        entryId: `O3:${escrow.escrowId}:${wallet.toLowerCase()}`,
        escrowId: escrow.escrowId,
        disputeId: null,
        sourceLogs: [escrow.createdLog, escrow.terminal.log],
        completing,
        parts,
        version,
        pairKey: pairOf(escrow),
      }),
      status,
    });
  }
}

function pushO4(candidates, escrow, state, versions, head) {
  const dispute = state.disputes.get(escrow.disputeId);
  if (!dispute?.resolvedLog) return;
  const opened = dispute.openedLog || null;
  const logs = [escrow.createdLog, escrow.disputedLog, dispute.resolvedLog, escrow.terminal.log];
  if (opened) logs.push(opened);
  const completing = later(logs);
  const version = requireVersion(versions, completing.blockNumber);
  const status = statusFor(logs, head);
  if (!status) return;
  const parts = [
    { name: "EscrowCreated", log: escrow.createdLog },
    { name: "EscrowDisputed", log: escrow.disputedLog },
    { name: "DisputeResolved", log: dispute.resolvedLog },
    { name: escrow.terminal.kind, log: escrow.terminal.log },
  ];
  if (opened) parts.push({ name: "DisputeOpened", log: opened });
  const pairKey = pairOf(escrow);
  const orderBlocked = !disputeFollowsEscrow(escrow, opened);
  for (const role of ["payer", "payee"]) {
    const wallet = escrow[role];
    const botId = role === "payer" ? escrow.payerBotId : escrow.payeeBotId;
    const nominal = role === "payer" ? version.points.O4_payer : version.points.O4_payee;
    if (nominal === 0) continue;
    candidates.push({
      ...baseEntry({
        outcome: "O4",
        nominal,
        ledger: USAGE_LEDGER,
        wallet,
        botId,
        role,
        semanticKey: `O4:${escrow.escrowId}`,
        entryId: `O4:${escrow.escrowId}:${wallet.toLowerCase()}`,
        escrowId: escrow.escrowId,
        disputeId: escrow.disputeId,
        sourceLogs: logs,
        completing,
        parts,
        version,
        pairKey,
      }),
      status,
      orderBlocked,
    });
  }
}

function pushO5(candidates, dispute, subject, versions, head) {
  const logs = [dispute.openedLog];
  const parts = [{ name: "DisputeOpened", log: dispute.openedLog }];
  if (subject?.terminal) {
    logs.push(subject.terminal.log);
    parts.push({ name: subject.terminal.kind, log: subject.terminal.log });
  }
  const completing = later(logs);
  const version = requireVersion(versions, completing.blockNumber);
  const status = statusFor(logs, head);
  if (!status) return;
  candidates.push({
    ...baseEntry({
      outcome: "O5",
      nominal: version.points.O5,
      ledger: USAGE_LEDGER,
      wallet: dispute.challenger,
      botId: null,
      role: "challenger",
      semanticKey: `O5:${dispute.disputeId}`,
      entryId: `O5:${dispute.disputeId}`,
      escrowId: subject?.escrowId || null,
      disputeId: dispute.disputeId,
      sourceLogs: logs,
      completing,
      parts,
      version,
    }),
    status: "provisional",
  });
}

function pushVote(candidates, dispute, escrow, vote, versions, head) {
  const opened = dispute.openedLog || null;
  const logs = [vote.log, dispute.resolvedLog, escrow.disputedLog];
  if (escrow.createdLog) logs.push(escrow.createdLog);
  if (opened) logs.push(opened);
  const completing = later(logs);
  const version = requireVersion(versions, completing.blockNumber);
  const status = statusFor(logs, head);
  if (!status) return;
  const parts = [
    { name: "VoteCast", log: vote.log },
    { name: "DisputeResolved", log: dispute.resolvedLog },
    { name: "EscrowDisputed", log: escrow.disputedLog },
  ];
  if (escrow.createdLog) parts.push({ name: "EscrowCreated", log: escrow.createdLog });
  if (opened) parts.push({ name: "DisputeOpened", log: opened });
  const orderBlocked = !disputeFollowsEscrow(escrow, opened);
  const partyBlocked = isParty(vote.voter, escrow);
  const shared = {
    ledger: ARBITRATOR_LEDGER,
    wallet: vote.voter,
    botId: null,
    role: "arbitrator",
    escrowId: escrow.escrowId,
    disputeId: dispute.disputeId,
    sourceLogs: logs,
    completing,
    parts,
    version,
  };
  if (version.points.A1 !== 0) {
    candidates.push({
      ...baseEntry({
        ...shared,
        outcome: "A1",
        nominal: version.points.A1,
        semanticKey: `A1:${dispute.disputeId}:${vote.voter.toLowerCase()}`,
        entryId: `A1:${dispute.disputeId}:${vote.voter.toLowerCase()}`,
      }),
      status,
      orderBlocked,
      partyBlocked,
    });
  }
  if (version.points.A2 !== 0 && vote.support === dispute.upheld) {
    candidates.push({
      ...baseEntry({
        ...shared,
        outcome: "A2",
        nominal: version.points.A2,
        semanticKey: `A2:${dispute.disputeId}:${vote.voter.toLowerCase()}`,
        entryId: `A2:${dispute.disputeId}:${vote.voter.toLowerCase()}`,
      }),
      status,
      orderBlocked,
      partyBlocked,
    });
  }
}

function disputeFollowsEscrow(escrow, openedLog) {
  if (!escrow?.createdLog || !openedLog) return false;
  return escrow.createdLog.blockNumber < openedLog.blockNumber;
}

function isParty(voter, escrow) {
  if (!voter || !escrow?.payer || !escrow?.payee) return false;
  const key = voter.toLowerCase();
  return key === escrow.payer.toLowerCase() || key === escrow.payee.toLowerCase();
}

function tierAt(bot, operatorLog) {
  let tier = null;
  for (const reg of bot.registrations || []) {
    if (cmpLog(reg.log, operatorLog) <= 0) tier = reg.tier;
  }
  return tier;
}

function requireVersion(versions, blockNumber) {
  const version = versionAt(versions, blockNumber);
  if (!version) throw httpError(400, "no_config_version", { blockNumber });
  return version;
}

function pairOf(escrow) {
  return `${escrow.payer.toLowerCase()}|${escrow.payee.toLowerCase()}`;
}

function adjustmentCandidate(row, versions, head) {
  const version = versionAt(versions, row.effective_block);
  if (!version) throw httpError(400, "no_config_version", { blockNumber: row.effective_block });
  const wallet = asAddress(row.wallet, "wallet");
  const completing = {
    blockNumber: row.effective_block,
    logIndex: Number.MAX_SAFE_INTEGER,
    blockHash: ZERO_HASH,
    txHash: ZERO_HASH,
    blockTimestamp: row.block_timestamp,
    address: ZERO,
    name: "ADJ",
  };
  const status = row.effective_block <= head.finalizedBlock ? "final" : "provisional";
  return {
    outcome_code: "ADJ",
    nominal_points: row.points,
    nominal: row.points,
    ledger: row.ledger,
    wallet,
    bot_id: row.bot_id ? asBytes32(row.bot_id, "bot_id") : null,
    role: "adjustment",
    semantic_key: `ADJ:${row.adjustment_id}`,
    entry_id: `ADJ:${row.adjustment_id}`,
    escrow_id: null,
    dispute_id: null,
    sourceLogs: [completing],
    completing,
    event_names: ["ADJ"],
    rule_version: version.rule_version,
    config_version: version.config_version,
    season_id: seasonKey(version, completing),
    day: utcDay(row.block_timestamp),
    pairKey: null,
    version,
    status,
    adjustment: row,
  };
}

function compareCandidate(a, b) {
  const block = a.completing.blockNumber - b.completing.blockNumber;
  if (block) return block;
  const index = a.completing.logIndex - b.completing.logIndex;
  if (index) return index;
  const rank = (OUTCOME_RANK[a.outcome_code] ?? 99) - (OUTCOME_RANK[b.outcome_code] ?? 99);
  if (rank) return rank;
  const role = (ROLE_RANK[a.role] ?? 99) - (ROLE_RANK[b.role] ?? 99);
  if (role) return role;
  return String(a.entry_id).localeCompare(String(b.entry_id));
}

function compareEntry(a, b) {
  if (a.block_number !== b.block_number) return a.block_number - b.block_number;
  const ai = a.log_index ?? Number.MAX_SAFE_INTEGER;
  const bi = b.log_index ?? Number.MAX_SAFE_INTEGER;
  if (ai !== bi) return ai - bi;
  return a.entry_id.localeCompare(b.entry_id);
}

function materialize(candidates, hooks, head) {
  const counters = {
    wallet: new Map(),
    bot: new Map(),
    escrow: new Map(),
    o3: new Map(),
    o4: new Map(),
    pairDay: new Map(),
    pairLife: new Map(),
    season: new Map(),
    arb: new Map(),
  };
  const pairDecision = new Map();
  const withheldFrom = new Map();
  const o5ByWallet = new Map();
  const flaggedDisputes = new Set();
  const entries = [];
  const signals = [];
  const enforcerFlags = [];
  const byId = new Map();

  for (const candidate of candidates) {
    if (candidate.outcome_code === "signal") {
      const decision = hooks.enforcer.flag(candidate.signal) || { withhold_wallet: false };
      const withhold = candidate.forceNoWithhold ? false : Boolean(decision.withhold_wallet);
      signals.push(candidate.signal);
      enforcerFlags.push({ ...candidate.signal, withhold_wallet: withhold });
      if (withhold && candidate.signal.wallet) {
        noteWithhold(withheldFrom, candidate.signal.wallet, candidate.signal.block_number);
      }
      continue;
    }
    if (candidate.outcome_code === "O5") {
      const entry = finishEntry(candidate, 0, { capped: false, cap_name: null, eligible: true, eligibility_reason: null, enforcer_withheld: false });
      const screen = hooks.eligibility({
        wallet: candidate.wallet,
        outcome_code: "O5",
        block_number: candidate.completing.blockNumber,
      });
      entry.eligible = Boolean(screen.eligible);
      entry.eligibility_reason = screen.reason || null;
      entries.push(entry);
      byId.set(entry.entry_id, entry);
      const list = o5ByWallet.get(candidate.wallet.toLowerCase()) || [];
      list.push({ day: candidate.day, disputeId: candidate.dispute_id, block: candidate.completing.blockNumber });
      o5ByWallet.set(candidate.wallet.toLowerCase(), list);
      const windowStart = candidate.day - (candidate.version.flags.o5_window_days - 1);
      const recent = list.filter((row) => row.day >= windowStart && row.day <= candidate.day);
      if (recent.length >= candidate.version.flags.o5_threshold) {
        const signal = {
          kind: "O5_REPEAT",
          wallet: candidate.wallet,
          bot_id: null,
          block_number: candidate.completing.blockNumber,
          refs: recent.map((row) => row.disputeId),
        };
        const decision = hooks.enforcer.flag(signal) || { withhold_wallet: false };
        signals.push(signal);
        enforcerFlags.push({ ...signal, withhold_wallet: Boolean(decision.withhold_wallet) });
        if (decision.withhold_wallet) noteWithhold(withheldFrom, candidate.wallet, candidate.completing.blockNumber);
      }
      continue;
    }
    if (candidate.outcome_code === "ADJ") {
      const row = candidate.adjustment;
      if (row.cancels_entry_id) {
        const target = byId.get(row.cancels_entry_id);
        if (!target) throw httpError(400, "unknown_adjustment_target", { entry_id: row.cancels_entry_id });
        target.status = "cancelled";
        target.cancel_reason = row.cancel_reason;
        target.cancelled_by = row.cancelled_by;
      }
      const entry = finishEntry(candidate, row.points, {
        capped: false,
        cap_name: null,
        eligible: true,
        eligibility_reason: null,
        enforcer_withheld: false,
      });
      entry.cancel_reason = row.cancel_reason;
      entry.cancelled_by = row.cancelled_by;
      entries.push(entry);
      byId.set(entry.entry_id, entry);
      continue;
    }

    const walletKey = candidate.wallet.toLowerCase();
    const withheld = isWithheld(withheldFrom, walletKey, candidate.completing.blockNumber);
    const gated = gatePoints(candidate);
    if (candidate.orderBlocked) noteOrderFlag(candidate, hooks, signals, enforcerFlags, flaggedDisputes);
    let points = gated.points;
    let capped = false;
    let capName = null;
    if (gated.blocked) {
      points = 0;
    } else if (withheld) {
      points = 0;
    } else {
      const pair = pairGate(candidate, pairDecision, counters);
      if (pair?.blocked) {
        points = 0;
        capped = true;
        capName = pair.reason;
        if (!pair.flagged) {
          pair.flagged = true;
          const signal = {
            kind: "PAIR_CAP",
            wallet: candidate.wallet,
            bot_id: candidate.bot_id,
            block_number: candidate.completing.blockNumber,
            refs: [candidate.semantic_key],
          };
          hooks.enforcer.flag(signal);
          signals.push(signal);
          enforcerFlags.push({ ...signal, withhold_wallet: false });
        }
      } else {
        capName = overCap(candidate, counters);
        if (capName) {
          points = 0;
          capped = true;
        }
      }
    }
    const screen = hooks.eligibility({
      wallet: candidate.wallet,
      outcome_code: candidate.outcome_code,
      block_number: candidate.completing.blockNumber,
    });
    const eligible = Boolean(screen.eligible);
    if (!eligible) points = 0;
    if (!gated.blocked && points > 0) {
      increment(candidate, counters, points);
      const pair = pairDecision.get(candidate.semantic_key);
      if (pair && !pair.counted) {
        pair.counted = true;
        bump(counters.pairDay, `${candidate.pairKey}:${candidate.day}`, 1);
        bump(counters.pairLife, candidate.pairKey, 1);
      }
    }
    const entry = finishEntry(candidate, points, {
      capped,
      cap_name: capName,
      eligible,
      eligibility_reason: screen.reason || null,
      enforcer_withheld: withheld,
    });
    entries.push(entry);
    byId.set(entry.entry_id, entry);
  }
  return { entries, signals, enforcerFlags };
}

function gatePoints(candidate) {
  let points = candidate.nominal_points;
  let blocked = false;
  if (candidate.outcome_code === "O1") {
    if (!candidate.o1TierOk) {
      points = 0;
      blocked = true;
    } else if (candidate.status === "final" && candidate.o1BurnedBefore) {
      points = 0;
      blocked = true;
    }
  }
  if (candidate.ledger === USAGE_LEDGER && candidate.version?.excluded?.has(candidate.wallet.toLowerCase())) {
    points = 0;
    blocked = true;
  }
  if (candidate.orderBlocked || candidate.partyBlocked) {
    points = 0;
    blocked = true;
  }
  return { points, blocked };
}

function noteOrderFlag(candidate, hooks, signals, enforcerFlags, flagged) {
  const disputeId = candidate.dispute_id;
  if (!disputeId || flagged.has(disputeId)) return;
  flagged.add(disputeId);
  const signal = {
    kind: "DISPUTE_PREDATES_ESCROW",
    wallet: null,
    bot_id: null,
    block_number: candidate.completing.blockNumber,
    refs: [disputeId],
  };
  hooks.enforcer.flag(signal);
  signals.push(signal);
  enforcerFlags.push({ ...signal, withhold_wallet: false });
}

function noteWithhold(map, wallet, blockNumber) {
  const key = wallet.toLowerCase();
  const prev = map.get(key);
  map.set(key, prev === undefined ? blockNumber : Math.min(prev, blockNumber));
}

function isWithheld(map, walletKey, blockNumber) {
  const from = map.get(walletKey);
  return from !== undefined && blockNumber >= from;
}

function pairGate(candidate, decisions, counters) {
  if (!candidate.pairKey) return null;
  const existing = decisions.get(candidate.semantic_key);
  if (existing) return existing;
  const caps = candidate.version.caps;
  const dayCount = counters.pairDay.get(`${candidate.pairKey}:${candidate.day}`) || 0;
  const lifeCount = counters.pairLife.get(candidate.pairKey) || 0;
  let reason = null;
  if (dayCount >= caps.pair_per_day) reason = "pair_per_day";
  else if (lifeCount >= caps.pair_lifetime) reason = "pair_lifetime";
  const decision = { blocked: Boolean(reason), reason, counted: false, flagged: false };
  decisions.set(candidate.semantic_key, decision);
  return decision;
}

function overCap(candidate, counters) {
  const caps = candidate.version.caps;
  const wallet = candidate.wallet.toLowerCase();
  const day = candidate.day;
  const points = candidate.nominal_points;
  if (candidate.outcome_code === "O3" && (counters.o3.get(`${wallet}:${day}`) || 0) >= caps.o3_per_wallet_per_day) {
    return "o3_per_wallet_per_day";
  }
  if (candidate.outcome_code === "O4" && (counters.o4.get(`${wallet}:${day}`) || 0) >= caps.o4_per_wallet_per_day) {
    return "o4_per_wallet_per_day";
  }
  if (
    (candidate.outcome_code === "O2" || candidate.outcome_code === "O3") &&
    (counters.escrow.get(`${wallet}:${day}`) || 0) >= caps.escrows_per_wallet_per_day
  ) {
    return "escrows_per_wallet_per_day";
  }
  if (candidate.ledger === USAGE_LEDGER) {
    if ((counters.wallet.get(`${wallet}:${day}`) || 0) + points > caps.usage_points_per_wallet_per_day) {
      return "usage_points_per_wallet_per_day";
    }
    if (candidate.bot_id && (counters.bot.get(`${candidate.bot_id}:${day}`) || 0) + points > caps.usage_points_per_bot_per_day) {
      return "usage_points_per_bot_per_day";
    }
    if (
      candidate.season_id &&
      (counters.season.get(`${candidate.season_id}:${wallet}`) || 0) + points > caps.usage_points_per_wallet_per_season
    ) {
      return "usage_points_per_wallet_per_season";
    }
  }
  if (candidate.ledger === ARBITRATOR_LEDGER) {
    if ((counters.arb.get(`${wallet}:${day}`) || 0) + points > caps.arbitrator_points_per_day) {
      return "arbitrator_points_per_day";
    }
  }
  return null;
}

function increment(candidate, counters, points) {
  const wallet = candidate.wallet.toLowerCase();
  const day = candidate.day;
  if (candidate.outcome_code === "O3") bump(counters.o3, `${wallet}:${day}`, 1);
  if (candidate.outcome_code === "O4") bump(counters.o4, `${wallet}:${day}`, 1);
  if (candidate.outcome_code === "O2" || candidate.outcome_code === "O3") bump(counters.escrow, `${wallet}:${day}`, 1);
  if (candidate.ledger === USAGE_LEDGER) {
    bump(counters.wallet, `${wallet}:${day}`, points);
    if (candidate.bot_id) bump(counters.bot, `${candidate.bot_id}:${day}`, points);
    if (candidate.season_id) bump(counters.season, `${candidate.season_id}:${wallet}`, points);
  }
  if (candidate.ledger === ARBITRATOR_LEDGER) bump(counters.arb, `${wallet}:${day}`, points);
}

function bump(map, key, by) {
  map.set(key, (map.get(key) || 0) + by);
}

function finishEntry(candidate, points, mask) {
  const log = candidate.completing;
  return {
    entry_id: candidate.entry_id,
    semantic_key: candidate.semantic_key,
    ledger: candidate.ledger,
    chain_id: 84532,
    wallet: candidate.wallet,
    bot_id: candidate.bot_id,
    outcome_code: candidate.outcome_code,
    points,
    nominal_points: candidate.nominal_points,
    capped: mask.capped,
    cap_name: mask.cap_name,
    status: candidate.status,
    source_contract: log.address,
    event_names: candidate.event_names,
    tx_hash: log.txHash,
    log_index: log.name === "ADJ" ? null : log.logIndex,
    block_number: log.blockNumber,
    block_hash: log.blockHash,
    block_timestamp: log.blockTimestamp,
    escrow_id: candidate.escrow_id,
    dispute_id: candidate.dispute_id,
    rule_version: candidate.rule_version,
    config_version: candidate.config_version,
    cancel_reason: null,
    cancelled_by: null,
    eligible: mask.eligible,
    eligibility_reason: mask.eligibility_reason,
    enforcer_withheld: mask.enforcer_withheld,
    role: candidate.role,
  };
}

export function contribution(entry) {
  if (!entry || entry.status === "cancelled") return 0;
  return entry.points;
}
