import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { ACTION } from "../src/constants.mjs";
import {
  account,
  createdLog,
  creditCandidate,
  disputedLog,
  rows,
  tempIndexer,
  voteLog,
} from "./support.mjs";

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(items, seed) {
  const copy = items.slice();
  const random = mulberry32(seed);
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function ledgerHash(indexer) {
  return createHash("sha256").update(indexer.canonical()).digest("hex");
}

function projection(indexer) {
  return rows(indexer).map((row) => [row.seq, row.action, row.tx_hash, row.log_index, row.wallet, row.escrow_id].join(":")).join("\n");
}

describe("ingest order", () => {
  it("builds the same rows and the same ledger hash from shuffled logs", async () => {
    const payer = account();
    const payee = account();
    const voter = account();
    const day = 21_400 * 86400;
    const escrowId = `0x${"d1".repeat(32)}`;
    const disputeId = `0x${"d2".repeat(32)}`;
    const fundFirst = createdLog({
      escrowId,
      payer: payer.address,
      payee: payee.address,
      expiresAt: day + 500,
      blockNumber: 49_400_001,
      logIndex: 1,
      txHash: `0x${"d1".repeat(32)}`,
      timestamp: day + 10,
    });
    const fundLater = createdLog({
      escrowId: `0x${"d3".repeat(32)}`,
      payer: payer.address,
      payee: payee.address,
      expiresAt: day + 500,
      blockNumber: 49_400_002,
      logIndex: 2,
      txHash: `0x${"d3".repeat(32)}`,
      timestamp: day + 20,
    });
    const dispute = disputedLog({
      escrowId,
      disputeId,
      party: payee.address,
      blockNumber: 49_400_010,
      logIndex: 1,
      txHash: `0x${"d4".repeat(32)}`,
      timestamp: day + 30,
    });
    const vote = voteLog({
      disputeId,
      voter: voter.address,
      blockNumber: 49_400_020,
      logIndex: 4,
      txHash: `0x${"d5".repeat(32)}`,
      timestamp: day + 40,
    });
    const ordered = [fundFirst, fundLater, dispute, vote];
    const signers = new Map([
      [payer.address.toLowerCase(), payer],
      [payee.address.toLowerCase(), payee],
      [voter.address.toLowerCase(), voter],
    ]);

    async function run(logs, creditSeed) {
      const ctx = tempIndexer();
      try {
        ctx.indexer.ingestLogs(logs);
        const candidates = shuffle(ctx.indexer.attribute().candidates, creditSeed);
        for (const candidate of candidates) {
          const credited = await creditCandidate(ctx.indexer, signers.get(candidate.wallet), candidate);
          assert.ok(credited.link, candidate.txHash);
        }
        return { hash: ledgerHash(ctx.indexer), rows: projection(ctx.indexer), canonical: ctx.indexer.canonical() };
      } finally {
        ctx.close();
      }
    }

    const baseline = await run(ordered, 1);
    assert.match(baseline.rows, new RegExp(fundFirst.transactionHash));
    assert.equal(baseline.rows.includes(fundLater.transactionHash), false);
    assert.match(baseline.rows, new RegExp(vote.transactionHash));
    assert.match(baseline.rows, new RegExp(ACTION.disputeOpenOrVote));
    const orders = [
      ordered.slice().reverse(),
      shuffle(ordered, 11),
      shuffle(ordered, 29),
      shuffle(ordered, 47),
    ];
    for (const [index, logs] of orders.entries()) {
      const next = await run(logs, 100 + index);
      assert.equal(next.hash, baseline.hash);
      assert.equal(next.rows, baseline.rows);
      assert.equal(next.canonical, baseline.canonical);
    }
  });
});
