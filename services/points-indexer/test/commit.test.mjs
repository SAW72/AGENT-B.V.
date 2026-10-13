import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ACTION, ESCROW, TOPIC, utcDay } from "../src/constants.mjs";
import { PointsError } from "../src/hex.mjs";
import { openIndexer } from "../src/indexer.mjs";
import {
  LIVE,
  account,
  byRole,
  createdLog,
  creditCandidate,
  disputedLog,
  loadFixture,
  rewriteEventWallets,
  rows,
  settlementLog,
  tempIndexer,
  upperLog,
  voteLog,
} from "./support.mjs";

async function creditedFixture() {
  const payer = account();
  const payee = account();
  const voters = [account(), account(), account()];
  const pairs = [
    [LIVE.payer, payer.address],
    [LIVE.payee, payee.address],
    [LIVE.voters[0], voters[0].address],
    [LIVE.voters[1], voters[1].address],
    [LIVE.voters[2], voters[2].address],
  ];
  const logs = rewriteEventWallets(loadFixture().logs, pairs);
  const ctx = tempIndexer();
  ctx.indexer.ingestLogs(logs, { observedAt: 1_800_000_000 });
  const signers = new Map([
    [payer.address.toLowerCase(), payer],
    [payee.address.toLowerCase(), payee],
    ...voters.map((voter) => [voter.address.toLowerCase(), voter]),
  ]);
  for (const candidate of ctx.indexer.attribute().candidates) {
    const signer = signers.get(candidate.wallet);
    assert.ok(signer, candidate.wallet);
    const result = await creditCandidate(ctx.indexer, signer, candidate);
    assert.equal(result.link?.ok, true, `${candidate.role} ${result.link?.reason}`);
  }
  return { ...ctx, payer, payee, voters, logs };
}

describe("committed rows from recorded logs", () => {
  it("credits the live shapes once, with throwaway wallets, and ignores tx.from", async () => {
    const ctx = await creditedFixture();
    try {
      const ledger = rows(ctx.indexer);
      assert.ok(ledger.every((row) => row.points === 0));
      assert.ok(ledger.every((row) => row.eligibility_status === "unverified"));
      assert.ok(ledger.every((row) => row.eligibility_reason === "ofac_unconfigured"));
      assert.ok(ledger.every((row) => row.points_withheld === 1));
      assert.ok(ledger.every((row) => row.log_index !== null && row.block_number !== null));
      const votes = rows(ctx.indexer, ACTION.disputeOpenOrVote).filter((row) => row.dispute_id === LIVE.dispute && row.support !== null);
      assert.equal(votes.length, 3);
      assert.ok(votes.every((row) => row.escrow_id === LIVE.escrow1));
      assert.ok(votes.every((row) => row.register_status === "pending"));
      assert.ok(votes.every((row) => row.points === 0));
      const releaseTx = "0x76bcbbb3de3b4ee42a9aa658363ccc3cb1a6f0be4c6375a9471ce05f0ac665ab";
      assert.equal(ledger.filter((row) => row.tx_hash === releaseTx && row.action === ACTION.releaseOrRefund).length, 1);
      assert.equal(ledger.some((row) => row.log_index === LIVE.creditedLog), false);
      assert.equal(ledger.some((row) => row.log_index === LIVE.resolvedLog && row.tx_hash.startsWith("0x10c98226")), false);
      for (const row of ledger.filter((row) => row.action !== ACTION.firstActivity && row.action !== ACTION.returnDay)) {
        const source = ctx.logs.find((log) => log.transactionHash === row.tx_hash && Number.parseInt(log.logIndex, 16) === row.log_index);
        assert.notEqual(row.wallet, source.transactionFrom);
      }
      const payerFirst = rows(ctx.indexer, ACTION.firstActivity).find((row) => row.wallet === ctx.payer.address.toLowerCase());
      const payeeFirst = rows(ctx.indexer, ACTION.firstActivity).find((row) => row.wallet === ctx.payee.address.toLowerCase());
      assert.equal(payerFirst.block_number, LIVE.createBlock);
      assert.equal(payerFirst.log_index, LIVE.createLog);
      assert.equal(payerFirst.source_action, ACTION.fund);
      assert.equal(payerFirst.source_tx_hash, payerFirst.tx_hash);
      assert.equal(payerFirst.source_log_index, payerFirst.log_index);
      assert.equal(payeeFirst.block_number, LIVE.disputeBlock);
      assert.equal(payeeFirst.log_index, LIVE.disputeLog);
      assert.equal(payeeFirst.source_action, ACTION.disputeOpenOrVote);
      assert.equal(rows(ctx.indexer, ACTION.firstActivity).length, 2);
      assert.equal(rows(ctx.indexer).some((row) => ctx.voters.some((voter) => voter.address.toLowerCase() === row.wallet && row.action === ACTION.firstActivity)), false);
      const again = ctx.indexer.canonical();
      ctx.indexer.ingestLogs(ctx.logs);
      assert.equal(ctx.indexer.canonical(), again);
      ctx.indexer.rebuild();
      assert.equal(ctx.indexer.canonical(), again);
    } finally {
      ctx.close();
    }
  });

  it("rejects a PointsLink from a throwaway key for an unre-written live wallet", async () => {
    const ctx = tempIndexer();
    try {
      ctx.indexer.ingestLogs(loadFixture().logs);
      const candidate = ctx.indexer.attribute().candidates.find((row) => row.role === "fund");
      const stranger = account();
      const result = await creditCandidate(ctx.indexer, stranger, candidate);
      assert.equal(result.link?.ok ?? result.issued.ok, false);
      assert.equal(rows(ctx.indexer).length, 0);
    } finally {
      ctx.close();
    }
  });
});

describe("daily cap and utc day", () => {
  it("splits 23:59:59Z and 00:00:00Z and ignores ingest time", async () => {
    const payer = account();
    const payee = account();
    const boundary = 20_000 * 86400;
    const logs = [
      createdLog({
        escrowId: `0x${"a1".repeat(32)}`,
        payer: payer.address,
        payee: payee.address,
        expiresAt: boundary + 1000,
        blockNumber: 48_000_010,
        logIndex: 1,
        txHash: `0x${"a1".repeat(32)}`,
        timestamp: boundary - 1,
      }),
      createdLog({
        escrowId: `0x${"a2".repeat(32)}`,
        payer: payer.address,
        payee: payee.address,
        expiresAt: boundary + 5000,
        blockNumber: 48_000_020,
        logIndex: 1,
        txHash: `0x${"a2".repeat(32)}`,
        timestamp: boundary,
      }),
    ];
    const ctx = tempIndexer();
    try {
      ctx.indexer.ingestLogs(logs, { observedAt: boundary + 10 * 86400 });
      for (const candidate of ctx.indexer.attribute().candidates) {
        assert.equal((await creditCandidate(ctx.indexer, payer, candidate)).link.ok, true);
      }
      const funds = rows(ctx.indexer, ACTION.fund);
      assert.equal(funds.length, 2);
      assert.equal(funds[0].utc_day, utcDay(boundary - 1));
      assert.equal(funds[1].utc_day, utcDay(boundary));
      assert.notEqual(funds[0].utc_day, funds[1].utc_day);
    } finally {
      ctx.close();
    }
  });

  it("keeps one release_or_refund slot per wallet per day and two actions on that day", async () => {
    const payer = account();
    const payee = account();
    const day = 20_100 * 86400 + 100;
    const shared = {
      payer: payer.address,
      payee: payee.address,
      expiresAt: day + 5000,
      timestamp: day,
    };
    const logs = [
      createdLog({ ...shared, escrowId: `0x${"b1".repeat(32)}`, blockNumber: 48_100_001, logIndex: 1, txHash: `0x${"b1".repeat(32)}` }),
      disputedLog({
        escrowId: `0x${"b1".repeat(32)}`,
        disputeId: `0x${"b2".repeat(32)}`,
        party: payer.address,
        blockNumber: 48_100_002,
        logIndex: 1,
        txHash: `0x${"b2".repeat(32)}`,
        timestamp: day + 10,
      }),
      settlementLog({
        kind: "refund",
        escrowId: `0x${"b1".repeat(32)}`,
        blockNumber: 48_100_003,
        logIndex: 1,
        txHash: `0x${"b3".repeat(32)}`,
        timestamp: day + 20,
        txFrom: LIVE.relayer,
      }),
      createdLog({
        ...shared,
        escrowId: `0x${"b4".repeat(32)}`,
        blockNumber: 48_100_004,
        logIndex: 1,
        txHash: `0x${"b4".repeat(32)}`,
        timestamp: day + 30,
      }),
      settlementLog({
        kind: "release",
        escrowId: `0x${"b4".repeat(32)}`,
        blockNumber: 48_100_005,
        logIndex: 1,
        txHash: `0x${"b5".repeat(32)}`,
        timestamp: day + 40,
        txFrom: payer.address,
      }),
    ];
    const ctx = tempIndexer();
    try {
      ctx.indexer.ingestLogs(logs);
      const signers = new Map([
        [payer.address.toLowerCase(), payer],
        [payee.address.toLowerCase(), payee],
      ]);
      const results = [];
      for (const candidate of ctx.indexer.attribute().candidates) {
        results.push(await creditCandidate(ctx.indexer, signers.get(candidate.wallet), candidate));
      }
      const payerRows = rows(ctx.indexer).filter((row) => row.wallet === payer.address.toLowerCase());
      assert.equal(payerRows.filter((row) => row.action === ACTION.fund).length, 1);
      assert.equal(payerRows.filter((row) => row.action === ACTION.disputeOpenOrVote).length, 1);
      assert.equal(payerRows.filter((row) => row.action === ACTION.releaseOrRefund).length, 1);
      const release = rows(ctx.indexer, ACTION.releaseOrRefund).find((row) => row.wallet === payee.address.toLowerCase());
      assert.ok(release);
      assert.notEqual(release.wallet, payer.address.toLowerCase());
      const secondFund = results.find((result) => result.link && result.link.reason === "duplicate_log");
      assert.ok(secondFund);
      assert.equal(ctx.indexer.canonical(), ctx.indexer.canonical());
    } finally {
      ctx.close();
    }
  });

  it("does not let a same-day release and refund both credit one wallet", async () => {
    const wallet = account();
    const other = account();
    const day = 20_200 * 86400 + 50;
    const logs = [
      createdLog({
        escrowId: `0x${"c1".repeat(32)}`,
        payer: wallet.address,
        payee: other.address,
        expiresAt: day + 100,
        blockNumber: 48_200_001,
        logIndex: 1,
        txHash: `0x${"c1".repeat(32)}`,
        timestamp: day,
      }),
      createdLog({
        escrowId: `0x${"c2".repeat(32)}`,
        payer: other.address,
        payee: wallet.address,
        expiresAt: day + 100,
        blockNumber: 48_200_002,
        logIndex: 1,
        txHash: `0x${"c2".repeat(32)}`,
        timestamp: day,
      }),
      settlementLog({ kind: "refund", escrowId: `0x${"c1".repeat(32)}`, blockNumber: 48_200_003, logIndex: 1, txHash: `0x${"c3".repeat(32)}`, timestamp: day, txFrom: LIVE.relayer }),
      settlementLog({ kind: "release", escrowId: `0x${"c2".repeat(32)}`, blockNumber: 48_200_004, logIndex: 1, txHash: `0x${"c4".repeat(32)}`, timestamp: day, txFrom: other.address }),
    ];
    const ctx = tempIndexer();
    try {
      ctx.indexer.ingestLogs(logs);
      const signers = new Map([[wallet.address.toLowerCase(), wallet], [other.address.toLowerCase(), other]]);
      for (const candidate of ctx.indexer.attribute().candidates) {
        await creditCandidate(ctx.indexer, signers.get(candidate.wallet), candidate);
      }
      const settled = rows(ctx.indexer, ACTION.releaseOrRefund).filter((row) => row.wallet === wallet.address.toLowerCase());
      assert.equal(settled.length, 1);
      assert.equal(settled[0].tx_hash, `0x${"c3".repeat(32)}`);
    } finally {
      ctx.close();
    }
  });
});

describe("derived rows", () => {
  it("re-derives a single first_activity and a return_day from a later zero-point escrow row", async () => {
    const payer = account();
    const payee = account();
    const firstTs = 20_300 * 86400 + 10;
    const laterTs = firstTs + 86400;
    const logs = [
      createdLog({
        escrowId: `0x${"d1".repeat(32)}`,
        payer: payer.address,
        payee: payee.address,
        expiresAt: firstTs + 100,
        blockNumber: 48_300_001,
        logIndex: 2,
        txHash: `0x${"d1".repeat(32)}`,
        timestamp: firstTs,
      }),
      createdLog({
        escrowId: `0x${"d2".repeat(32)}`,
        payer: payer.address,
        payee: payee.address,
        expiresAt: laterTs + 100,
        blockNumber: 48_300_050,
        logIndex: 3,
        txHash: `0x${"d2".repeat(32)}`,
        timestamp: laterTs,
      }),
    ];
    const ctx = tempIndexer();
    try {
      ctx.indexer.ingestLogs(logs);
      for (const candidate of ctx.indexer.attribute().candidates) {
        assert.equal((await creditCandidate(ctx.indexer, payer, candidate)).link.ok, true);
      }
      assert.equal(rows(ctx.indexer, ACTION.firstActivity).length, 1);
      assert.equal(rows(ctx.indexer, ACTION.returnDay).length, 1);
      assert.equal(rows(ctx.indexer, ACTION.returnDay)[0].source_action, ACTION.fund);
      assert.equal(rows(ctx.indexer, ACTION.returnDay)[0].points, 0);
      const before = ctx.indexer.canonical();
      ctx.indexer.rebuild();
      assert.equal(ctx.indexer.canonical(), before);
      const source = rows(ctx.indexer, ACTION.fund)[0];
      const derived = rows(ctx.indexer, ACTION.firstActivity)[0];
      assert.equal(derived.tx_hash, source.tx_hash);
      assert.equal(derived.log_index, source.log_index);
      assert.notEqual(derived.action, source.action);
    } finally {
      ctx.close();
    }
  });

  it("does not derive rows when the source link is missing, and skips a removed source", async () => {
    const payer = account();
    const payee = account();
    const ts = 20_400 * 86400 + 10;
    const kept = createdLog({
      escrowId: `0x${"e2".repeat(32)}`,
      payer: payer.address,
      payee: payee.address,
      expiresAt: ts + 100,
      blockNumber: 48_400_020,
      logIndex: 1,
      txHash: `0x${"e2".repeat(32)}`,
      timestamp: ts + 5,
    });
    const removed = createdLog({
      escrowId: `0x${"e1".repeat(32)}`,
      payer: payer.address,
      payee: payee.address,
      expiresAt: ts + 100,
      blockNumber: 48_400_010,
      logIndex: 1,
      txHash: `0x${"e1".repeat(32)}`,
      timestamp: ts,
      removed: true,
    });
    const ctx = tempIndexer();
    try {
      ctx.indexer.ingestLogs([removed, kept]);
      assert.equal(rows(ctx.indexer).length, 0);
      const candidate = ctx.indexer.attribute().candidates[0];
      assert.equal(candidate.txHash, kept.transactionHash);
      await creditCandidate(ctx.indexer, payer, candidate);
      assert.equal(rows(ctx.indexer, ACTION.firstActivity)[0].tx_hash, kept.transactionHash);
      assert.equal(rows(ctx.indexer, ACTION.fund).length, 1);
    } finally {
      ctx.close();
    }
  });

  it("gives a later counting vote a return_day and withholds one while the weight is unset", async () => {
    const payer = account();
    const payee = account();
    const voter = account();
    const day = 20_500 * 86400;
    const disputeId = `0x${"f2".repeat(32)}`;
    const logs = [
      createdLog({
        escrowId: `0x${"f0".repeat(32)}`,
        payer: voter.address,
        payee: payee.address,
        expiresAt: day + 1000,
        blockNumber: 48_500_000,
        logIndex: 1,
        txHash: `0x${"f0".repeat(32)}`,
        timestamp: day + 5,
      }),
      createdLog({
        escrowId: `0x${"f1".repeat(32)}`,
        payer: payer.address,
        payee: payee.address,
        expiresAt: day + 1000,
        blockNumber: 48_500_001,
        logIndex: 1,
        txHash: `0x${"f1".repeat(32)}`,
        timestamp: day + 10,
      }),
      disputedLog({
        escrowId: `0x${"f1".repeat(32)}`,
        disputeId,
        party: payee.address,
        blockNumber: 48_500_002,
        logIndex: 1,
        txHash: `0x${"f2".repeat(32)}`,
        timestamp: day + 20,
      }),
      voteLog({
        disputeId,
        voter: voter.address,
        blockNumber: 48_500_090,
        logIndex: 1,
        txHash: `0x${"f3".repeat(32)}`,
        timestamp: day + 86400 + 30,
      }),
    ];
    const ctx = tempIndexer();
    try {
      ctx.indexer.ingestLogs(logs);
      const signers = new Map([
        [payer.address.toLowerCase(), payer],
        [payee.address.toLowerCase(), payee],
        [voter.address.toLowerCase(), voter],
      ]);
      for (const candidate of ctx.indexer.attribute().candidates) {
        await creditCandidate(ctx.indexer, signers.get(candidate.wallet), candidate);
      }
      assert.equal(rows(ctx.indexer, ACTION.returnDay).length, 0);
      const voteRow = () => rows(ctx.indexer).find((row) => row.wallet === voter.address.toLowerCase() && row.action === ACTION.disputeOpenOrVote);
      assert.equal(voteRow().points, 0);
      assert.equal(voteRow().register_status, "pending");
      ctx.indexer.setRegister({ voters: { [voter.address]: "human" } });
      ctx.indexer.setWeights({ vote: 5 });
      assert.equal(voteRow().points, 0);
      assert.equal(voteRow().rule_weight, 5);
      const returned = rows(ctx.indexer, ACTION.returnDay);
      assert.equal(returned.length, 1);
      assert.equal(returned[0].wallet, voter.address.toLowerCase());
      assert.equal(returned[0].source_action, ACTION.disputeOpenOrVote);
      ctx.indexer.setRegister({ voters: { [voter.address]: "ai" } });
      assert.equal(rows(ctx.indexer, ACTION.returnDay).length, 0);
      assert.equal(voteRow().register_status, "ai");
    } finally {
      ctx.close();
    }
  });
});

describe("gates and relay", () => {
  it("applies same_pair and min_escrow_amount only when a number is set", async () => {
    const payer = account();
    const payee = account();
    const day = 20_600 * 86400 + 5;
    const logs = [1, 2].map((n) => createdLog({
      escrowId: `0x${String(n).repeat(64)}`,
      payer: payer.address,
      payee: payee.address,
      amount: n === 1 ? 1n : 10n ** 15n,
      expiresAt: day + (n - 1) * 86400 + 100,
      blockNumber: 48_600_000 + n,
      logIndex: 1,
      txHash: `0x${String(n + 3).repeat(64)}`.slice(0, 66),
      timestamp: day + (n - 1) * 86400,
    }));
    const ctx = tempIndexer();
    try {
      ctx.indexer.ingestLogs(logs);
      for (const candidate of ctx.indexer.attribute().candidates) {
        assert.equal((await creditCandidate(ctx.indexer, payer, candidate)).link.ok, true);
      }
      assert.equal(rows(ctx.indexer, ACTION.fund).length, 2);
      ctx.indexer.setGates({ min_escrow_amount_wei: "2", same_pair_lifetime: null, same_pair_per_day: null, min_escrow_duration_seconds: null });
      assert.equal(rows(ctx.indexer, ACTION.fund).length, 1);
      assert.equal(rows(ctx.indexer, ACTION.firstActivity)[0].block_number, 48_600_002);
      ctx.indexer.setGates({ min_escrow_amount_wei: null, same_pair_lifetime: 1, same_pair_per_day: null, min_escrow_duration_seconds: null });
      assert.equal(rows(ctx.indexer, ACTION.fund).length, 1);
    } finally {
      ctx.close();
    }
  });

  it("credits a relayed refund to the payer and not the relayer", async () => {
    const payer = account();
    const payee = account();
    const relayer = account();
    const day = 20_700 * 86400 + 5;
    const escrowId = `0x${"71".repeat(32)}`;
    const logs = [
      createdLog({
        escrowId,
        payer: payer.address,
        payee: payee.address,
        expiresAt: day + 50,
        blockNumber: 48_700_001,
        logIndex: 1,
        txHash: `0x${"71".repeat(32)}`,
        timestamp: day,
      }),
      settlementLog({
        kind: "refund",
        escrowId,
        blockNumber: 48_700_010,
        logIndex: 1,
        txHash: `0x${"72".repeat(32)}`,
        timestamp: day + 10,
        txFrom: relayer.address,
      }),
    ];
    const ctx = tempIndexer();
    try {
      ctx.indexer.ingestLogs(logs);
      const refund = ctx.indexer.attribute().candidates.find((row) => row.role === "refund");
      assert.equal(refund.wallet, payer.address.toLowerCase());
      assert.equal(refund.txFrom, relayer.address.toLowerCase());
      const wrong = await creditCandidate(ctx.indexer, relayer, { ...refund, wallet: relayer.address.toLowerCase() });
      assert.notEqual(wrong.issued.ok, true);
      assert.equal(rows(ctx.indexer, ACTION.releaseOrRefund).length, 0);
      const right = await creditCandidate(ctx.indexer, payer, refund);
      assert.equal(right.link.ok, true);
      assert.equal(rows(ctx.indexer, ACTION.releaseOrRefund)[0].wallet, payer.address.toLowerCase());
    } finally {
      ctx.close();
    }
  });
});

describe("refused inputs", () => {
  it("rejects chain ids 1 and 8453 and a client-supplied key", () => {
    assert.throws(() => openIndexer({ path: ":memory:", chainId: 8453, finalizedBlock: 1 }), PointsError);
    assert.throws(() => openIndexer({ path: ":memory:", chainId: 1, finalizedBlock: 1 }), PointsError);
    const ctx = tempIndexer();
    try {
      const rejected = ctx.indexer.rejectClientKey({ chain_id: 84532, tx_hash: `0x${"1".repeat(64)}`, log_index: 1, points: 10 });
      assert.equal(rejected.reason, "client_key_rejected");
      assert.equal(rejected.committed, false);
      assert.equal(rows(ctx.indexer).length, 0);
      assert.throws(() => ctx.indexer.ingestLogs([], { chainId: 8453 }), /wrong_chain/);
    } finally {
      ctx.close();
    }
  });

  it("collapses mixed-case replay onto one raw log", () => {
    const payer = account();
    const payee = account();
    const log = createdLog({
      escrowId: `0x${"81".repeat(32)}`,
      payer: payer.address,
      payee: payee.address,
      expiresAt: 100,
      blockNumber: 48_800_001,
      logIndex: 4,
      txHash: `0x${"81".repeat(32)}`,
      timestamp: 20_800 * 86400,
    });
    const ctx = tempIndexer();
    try {
      ctx.indexer.ingestLogs([log]);
      ctx.indexer.ingestLogs([upperLog(log)]);
      assert.equal(ctx.indexer.rawCount(), 1);
    } finally {
      ctx.close();
    }
  });

  it("commits one re-included log and only once it is finalized", async () => {
    const payer = account();
    const payee = account();
    const removed = createdLog({
      escrowId: `0x${"91".repeat(32)}`,
      payer: payer.address,
      payee: payee.address,
      expiresAt: 100,
      blockNumber: 48_900_001,
      logIndex: 1,
      txHash: `0x${"91".repeat(32)}`,
      timestamp: 20_900 * 86400,
      removed: true,
    });
    const kept = createdLog({
      escrowId: `0x${"91".repeat(32)}`,
      payer: payer.address,
      payee: payee.address,
      expiresAt: 100,
      blockNumber: 48_900_050,
      logIndex: 2,
      txHash: `0x${"92".repeat(32)}`,
      timestamp: 20_900 * 86400 + 20,
    });
    const ctx = tempIndexer({ finalizedBlock: 48_900_000 });
    try {
      ctx.indexer.ingestLogs([removed, kept]);
      assert.equal(ctx.indexer.attribute().candidates.length, 0);
      assert.equal(rows(ctx.indexer).length, 0);
      ctx.indexer.setFinalizedBlock(48_900_050);
      const candidate = ctx.indexer.attribute().candidates[0];
      assert.equal(candidate.txHash, kept.transactionHash);
      assert.equal((await creditCandidate(ctx.indexer, payer, candidate)).link.ok, true);
      assert.equal(rows(ctx.indexer, ACTION.fund).length, 1);
      const canonical = ctx.indexer.canonical();
      ctx.indexer.ingestLogs([removed, kept]);
      ctx.indexer.rebuild();
      assert.equal(ctx.indexer.canonical(), canonical);
    } finally {
      ctx.close();
    }
  });
});

describe("attribution helpers stay unused in the ledger until a link exists", () => {
  it("stores no row for a matched vote that has no chain", () => {
    const fixture = loadFixture();
    const ctx = tempIndexer();
    try {
      ctx.indexer.ingestLogs(fixture.logs);
      assert.equal(byRole(ctx.indexer.attribute().candidates, "vote").length, 3);
      assert.equal(rows(ctx.indexer).length, 0);
      assert.equal(fixture.logs.some((log) => log.topics[0] === TOPIC.escrowDisputed), true);
      assert.equal(ESCROW, fixture.logs.find((log) => log.topics[0] === TOPIC.escrowCreated).address.toLowerCase());
    } finally {
      ctx.close();
    }
  });
});
