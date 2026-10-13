import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keccak256, toBytes } from "viem";
import { attributeLogs } from "../src/attribute.mjs";
import { ESCROW, ESCROW_START_BLOCK, PANEL, TOPIC } from "../src/constants.mjs";
import { LIVE, createdLog, disputedLog, loadFixture, makeLog, settlementLog, voteLog } from "./support.mjs";

const FINAL = 100_000_000;

function attr(logs, finalizedBlock = FINAL) {
  return attributeLogs(logs, { finalizedBlock, chainId: 84532 });
}

describe("recorded Base Sepolia logs", () => {
  const fixture = loadFixture();

  it("keeps the captured escrow and panel logs", () => {
    assert.equal(fixture.chain_id, 84532);
    assert.equal(fixture.logs.length, 24);
    assert.ok(fixture.logs.every((log) => log.removed === false));
    const hashes = new Set(fixture.logs.map((log) => log.transactionHash));
    assert.ok(hashes.has("0xafecdb9fb2c3ff0bad55b83588d654ed5f8a3b3d2f1133595382e7383abf5827"));
    assert.ok(hashes.has("0x14b4f0fcf33645a6b3972b96c23151b44b35f66595b0ff480f6a2d2d18a266c3"));
    assert.ok(hashes.has("0x76bcbbb3de3b4ee42a9aa658363ccc3cb1a6f0be4c6375a9471ce05f0ac665ab"));
    assert.ok(hashes.has("0x794a3b2258a3a0ff044bfaf2373d8ec8ed24408f7edfcdd5d861dc1368bd5e7d"));
    assert.ok(hashes.has("0x10c982265d64d3831104054b73d53228f0f81fcdb77c3cf1003940b309b88868"));
  });

  it("recomputes the points topic0 values", () => {
    assert.equal(keccak256(toBytes("EscrowCreated(bytes32,address,address,bytes32,bytes32,uint256,uint256)")), TOPIC.escrowCreated);
    assert.equal(keccak256(toBytes("EscrowReleased(bytes32,uint256)")), TOPIC.escrowReleased);
    assert.equal(keccak256(toBytes("EscrowRefunded(bytes32,uint256)")), TOPIC.escrowRefunded);
    assert.equal(keccak256(toBytes("EscrowDisputed(bytes32,bytes32,address)")), TOPIC.escrowDisputed);
    assert.equal(keccak256(toBytes("EscrowDisputed(bytes32,bytes32)")), TOPIC.escrowDisputedRetired);
    assert.equal(keccak256(toBytes("VoteCast(bytes32,address,bool)")), TOPIC.voteCast);
    assert.equal(keccak256(toBytes("Credited(bytes32,address,uint256,bool)")), "0x4a528a1ce44e0b5c59afa1f1918b28b54e9dcb644273e02d50989a373853d642");
    assert.equal(keccak256(toBytes("DisputeResolved(bytes32,bool)")), TOPIC.disputeResolved);
  });

  it("joins the live dispute to exactly three votes and ignores Credited", () => {
    const { candidates } = attr(fixture.logs);
    const votes = candidates.filter((row) => row.role === "vote");
    assert.equal(votes.length, 3);
    assert.ok(votes.every((row) => row.escrowId === LIVE.escrow1));
    assert.ok(votes.every((row) => row.disputeId === LIVE.dispute));
    assert.deepEqual(votes.map((row) => row.wallet), LIVE.voters);
    const releaseTx = "0x76bcbbb3de3b4ee42a9aa658363ccc3cb1a6f0be4c6375a9471ce05f0ac665ab";
    const releaseRows = candidates.filter((row) => row.txHash === releaseTx);
    assert.equal(releaseRows.length, 1);
    assert.equal(releaseRows[0].logIndex, LIVE.releaseLog);
    assert.equal(releaseRows[0].wallet, LIVE.payee);
    assert.ok(candidates.every((row) => row.logIndex !== LIVE.creditedLog));
  });

  it("decodes the 3-arg EscrowDisputed and does not count DisputeResolved", () => {
    const { candidates } = attr(fixture.logs);
    const open = candidates.find((row) => row.role === "dispute_open");
    assert.equal(open.blockNumber, LIVE.disputeBlock);
    assert.equal(open.logIndex, LIVE.disputeLog);
    assert.equal(open.wallet, LIVE.payee);
    assert.equal(open.disputeId, LIVE.dispute);
    assert.equal(open.escrowId, LIVE.escrow1);
    const resolving = "0x10c982265d64d3831104054b73d53228f0f81fcdb77c3cf1003940b309b88868";
    const inTx = candidates.filter((row) => row.txHash === resolving);
    assert.equal(inTx.length, 1);
    assert.equal(inTx[0].logIndex, LIVE.finalVoteLog);
    assert.equal(inTx[0].role, "vote");
  });

  it("attributes release to the create-time payee and refund to the create-time payer", () => {
    const { candidates } = attr(fixture.logs);
    const release = candidates.find((row) => row.role === "release");
    const refund = candidates.find((row) => row.role === "refund");
    assert.equal(release.wallet, LIVE.payee);
    assert.notEqual(release.wallet, release.txFrom);
    assert.equal(refund.wallet, LIVE.payer);
    assert.equal(refund.txFrom, LIVE.relayer);
    assert.notEqual(refund.wallet, refund.txFrom);
    assert.equal(refund.escrowId, LIVE.escrow2);
  });

  it("defers a VoteCast seen before its EscrowDisputed, then keeps it", () => {
    const vote = fixture.logs.find((log) => Number.parseInt(log.logIndex, 16) === 95 && log.topics[0] === TOPIC.voteCast);
    const dispute = fixture.logs.find((log) => Number.parseInt(log.logIndex, 16) === LIVE.disputeLog);
    const early = attr([vote]);
    assert.equal(early.candidates.length, 0);
    assert.equal(early.deferred.length, 1);
    assert.equal(early.deferred[0].reason, "dispute_not_stored");
    const later = attr([vote, dispute, fixture.logs.find((log) => log.topics[0] === TOPIC.escrowCreated && log.topics[1] === LIVE.escrow1)]);
    assert.equal(later.candidates.filter((row) => row.role === "vote").length, 1);
    assert.equal(later.deferred.length, 0);
  });
});

describe("negative joins", () => {
  it("rejects an EscrowDisputed before the escrow start block", () => {
    const fixture = loadFixture();
    const dispute = structuredClone(fixture.logs.find((log) => Number.parseInt(log.logIndex, 16) === LIVE.disputeLog));
    dispute.blockNumber = `0x${(ESCROW_START_BLOCK - 1).toString(16)}`;
    dispute.blockTimestamp = "0x1";
    const { candidates, skipped } = attr([dispute]);
    assert.equal(candidates.length, 0);
    assert.ok(skipped.some((row) => row.reason === "start_block"));
  });

  it("ignores the retired 2-arg EscrowDisputed topic on the live address", () => {
    const log = makeLog({
      address: ESCROW,
      topics: [TOPIC.escrowDisputedRetired, LIVE.escrow1],
      data: LIVE.dispute,
      blockNumber: 47938201,
      logIndex: 1,
      txHash: `0x${"12".repeat(32)}`,
      timestamp: 1791644690,
    });
    const { candidates, skipped } = attr([log]);
    assert.equal(candidates.length, 0);
    assert.ok(skipped.some((row) => row.reason === "retired_dispute_shape"));
  });

  it("does not count a VoteCast whose disputeId only matches a retired escrow", () => {
    const disputeId = `0x${"ab".repeat(32)}`;
    const logs = [
      disputedLog({
        address: LIVE.retired,
        escrowId: `0x${"cd".repeat(32)}`,
        disputeId,
        party: LIVE.payer,
        blockNumber: 47940000,
        logIndex: 1,
        txHash: `0x${"13".repeat(32)}`,
        timestamp: 1791645000,
      }),
      voteLog({
        disputeId,
        voter: LIVE.voters[0],
        blockNumber: 47940010,
        logIndex: 2,
        txHash: `0x${"14".repeat(32)}`,
        timestamp: 1791645100,
      }),
    ];
    const { candidates, deferred, skipped } = attr(logs);
    assert.equal(candidates.filter((row) => row.role === "vote").length, 0);
    assert.ok(deferred.some((row) => row.reason === "dispute_not_stored"));
    assert.ok(skipped.some((row) => row.reason === "retired_escrow"));
  });

  it("drops an unknown disputeId and a vote by the payee", () => {
    const fixture = loadFixture();
    const unknown = voteLog({
      disputeId: `0x${"ee".repeat(32)}`,
      voter: LIVE.voters[0],
      blockNumber: 47939000,
      logIndex: 4,
      txHash: `0x${"15".repeat(32)}`,
      timestamp: 1791645200,
    });
    const partyVote = voteLog({
      disputeId: LIVE.dispute,
      voter: LIVE.payee,
      blockNumber: 47939010,
      logIndex: 5,
      txHash: `0x${"16".repeat(32)}`,
      timestamp: 1791645300,
    });
    const { candidates, skipped, deferred } = attr([...fixture.logs, unknown, partyVote]);
    assert.equal(candidates.filter((row) => row.role === "vote").length, 3);
    assert.ok(deferred.some((row) => row.txHash === unknown.transactionHash));
    assert.ok(skipped.some((row) => row.reason === "voter_is_party" && row.wallet === LIVE.payee));
  });

  it("skips removed logs and withholds logs above the finalized block", () => {
    const fixture = loadFixture();
    const removed = structuredClone(fixture.logs.find((log) => log.topics[0] === TOPIC.escrowCreated));
    removed.removed = true;
    const onlyRemoved = attr([removed]);
    assert.equal(onlyRemoved.candidates.length, 0);
    assert.ok(onlyRemoved.skipped.some((row) => row.reason === "removed"));
    const head = attr(fixture.logs, 47938103);
    assert.equal(head.candidates.length, 0);
    assert.ok(head.withheld.some((row) => row.reason === "not_finalized"));
  });

  it("refuses a chain id other than 84532", () => {
    assert.throws(() => attributeLogs([], { finalizedBlock: 1, chainId: 8453 }), /wrong_chain/);
    assert.throws(() => attributeLogs([], { finalizedBlock: 1, chainId: 1 }), /wrong_chain/);
  });
});

describe("panel logs are admitted only by disputeId", () => {
  it("counts a VoteCast from before the escrow start block when the dispute matches", () => {
    const fixture = loadFixture();
    const early = voteLog({
      disputeId: LIVE.dispute,
      voter: "0x1111111111111111111111111111111111111111",
      blockNumber: 47253021,
      logIndex: 9,
      txHash: `0x${"17".repeat(32)}`,
      timestamp: 1790300000,
    });
    const { candidates } = attr([...fixture.logs, early]);
    const matched = candidates.find((row) => row.txHash === early.transactionHash);
    assert.ok(matched);
    assert.equal(matched.escrowId, LIVE.escrow1);
    assert.ok(matched.blockNumber < ESCROW_START_BLOCK);
    assert.equal(PANEL, early.address.toLowerCase());
  });
});

describe("duplicate ids are ambiguous", () => {
  it("skips a repeated escrowId or disputeId and writes no credit for either copy", () => {
    const payer = "0x1111111111111111111111111111111111111111";
    const payee = "0x2222222222222222222222222222222222222222";
    const voter = "0x3333333333333333333333333333333333333333";
    const escrowId = `0x${"a1".repeat(32)}`;
    const disputeId = `0x${"b2".repeat(32)}`;
    const day = 20_800 * 86400;
    const logs = [
      createdLog({
        escrowId,
        payer,
        payee,
        expiresAt: day + 100,
        blockNumber: 48_800_001,
        logIndex: 1,
        txHash: `0x${"a1".repeat(32)}`,
        timestamp: day + 1,
      }),
      createdLog({
        escrowId,
        payer,
        payee,
        expiresAt: day + 200,
        blockNumber: 48_800_002,
        logIndex: 1,
        txHash: `0x${"a2".repeat(32)}`,
        timestamp: day + 2,
      }),
      settlementLog({
        kind: "release",
        escrowId,
        blockNumber: 48_800_003,
        logIndex: 1,
        txHash: `0x${"a3".repeat(32)}`,
        timestamp: day + 3,
      }),
      createdLog({
        escrowId: `0x${"a4".repeat(32)}`,
        payer,
        payee,
        expiresAt: day + 100,
        blockNumber: 48_800_004,
        logIndex: 1,
        txHash: `0x${"a4".repeat(32)}`,
        timestamp: day + 4,
      }),
      disputedLog({
        escrowId: `0x${"a4".repeat(32)}`,
        disputeId,
        party: payee,
        blockNumber: 48_800_005,
        logIndex: 1,
        txHash: `0x${"b1".repeat(32)}`,
        timestamp: day + 5,
      }),
      disputedLog({
        escrowId: `0x${"a4".repeat(32)}`,
        disputeId,
        party: payer,
        blockNumber: 48_800_006,
        logIndex: 1,
        txHash: `0x${"b2".repeat(32)}`,
        timestamp: day + 6,
      }),
      voteLog({
        disputeId,
        voter,
        blockNumber: 48_800_007,
        logIndex: 1,
        txHash: `0x${"b3".repeat(32)}`,
        timestamp: day + 7,
      }),
    ];
    const { candidates, skipped } = attr(logs);
    assert.equal(candidates.some((row) => row.escrowId === escrowId), false);
    assert.equal(candidates.some((row) => row.disputeId === disputeId), false);
    assert.equal(candidates.filter((row) => row.role === "fund").length, 1);
    assert.equal(candidates.filter((row) => row.role === "dispute_open").length, 0);
    assert.equal(candidates.filter((row) => row.role === "vote").length, 0);
    assert.equal(candidates.filter((row) => row.role === "release").length, 0);
    assert.equal(skipped.filter((row) => row.reason === "ambiguous_escrow").length, 3);
    assert.equal(skipped.filter((row) => row.reason === "ambiguous_dispute").length, 3);
  });
});
