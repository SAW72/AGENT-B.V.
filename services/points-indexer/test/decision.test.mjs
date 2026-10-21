import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, hashTypedData } from "viem";
import { ACTION, SECP256K1_HALF_N, SECP256K1_N } from "../src/constants.mjs";
import { inspectSignature, recoverSigner } from "../src/signature.mjs";
import {
  POINTS_DOMAIN,
  POINTS_LINK_TYPES,
} from "../src/signature.mjs";
import {
  account,
  createdLog,
  creditCandidate,
  rows,
  signLink,
  tempIndexer,
} from "./support.mjs";

function fundSetup() {
  const payer = account();
  const payee = account();
  const timestamp = 21_000 * 86400 + 100;
  const log = createdLog({
    escrowId: `0x${"aa".repeat(32)}`,
    payer: payer.address,
    payee: payee.address,
    expiresAt: timestamp + 1000,
    blockNumber: 49_000_010,
    logIndex: 7,
    txHash: `0x${"bb".repeat(32)}`,
    timestamp,
  });
  return { payer, payee, log, timestamp };
}

async function prepared(options = {}) {
  const setup = fundSetup();
  const ctx = tempIndexer(options);
  ctx.indexer.ingestLogs([setup.log]);
  const candidate = ctx.indexer.attribute().candidates[0];
  return { ...setup, ...ctx, candidate };
}

describe("decision chain", () => {
  it("rejects a chain entry at the log timestamp and an AI terminal approver", async () => {
    const late = await prepared();
    try {
      const result = await creditCandidate(late.indexer, late.payer, late.candidate, { terminalOffset: 0 });
      assert.equal(result.link?.ok, false);
      assert.equal(rows(late.indexer).length, 0);
      assert.ok(late.indexer.listChains().length >= 1);
    } finally {
      late.close();
    }
    const blocked = await prepared();
    try {
      const ai = account();
      const result = await creditCandidate(blocked.indexer, blocked.payer, blocked.candidate, {
        approver: ai,
        approverType: "ai",
        accountableHumanId: blocked.payer.address,
      });
      assert.equal(result.chain.accepted, false);
      assert.equal(result.chain.reason, "terminal_not_human");
      assert.equal(rows(blocked.indexer).length, 0);
    } finally {
      blocked.close();
    }
    const good = await prepared();
    try {
      const result = await creditCandidate(good.indexer, good.payer, good.candidate, { proposer: account() });
      assert.equal(result.chain.accepted, true);
      assert.equal(result.link.ok, true);
      assert.equal(rows(good.indexer, ACTION.fund).length, 1);
    } finally {
      good.close();
    }
  });

  it("does not treat accountable_human_id as authority and refuses a checkbox human", async () => {
    const ctx = await prepared();
    try {
      ctx.indexer.setOrigin(ctx.payer.address, {
        actorType: "human",
        identityAnchor: false,
        behavioralSignals: false,
        modelVersion: "",
      });
      const result = await creditCandidate(ctx.indexer, ctx.payer, ctx.candidate, {
        identityAnchor: false,
        behavioralSignals: false,
      });
      assert.equal(result.chain.accepted, false);
      assert.equal(rows(ctx.indexer).length, 0);
    } finally {
      ctx.close();
    }
  });
});

describe("nonce binding, revoke, and reissue", () => {
  it("binds a nonce to txHash, logIndex, and wallet", async () => {
    const ctx = await prepared();
    try {
      const other = createdLog({
        escrowId: `0x${"cc".repeat(32)}`,
        payer: ctx.payer.address,
        payee: ctx.payee.address,
        expiresAt: ctx.timestamp + 1000,
        blockNumber: 49_000_020,
        logIndex: 8,
        txHash: `0x${"dd".repeat(32)}`,
        timestamp: ctx.timestamp + 86400,
      });
      ctx.indexer.ingestLogs([ctx.log, other]);
      const first = ctx.indexer.attribute().candidates.find((row) => row.txHash === ctx.log.transactionHash);
      const second = ctx.indexer.attribute().candidates.find((row) => row.txHash === other.transactionHash);
      assert.equal((await creditCandidate(ctx.indexer, ctx.payer, first)).link.ok, true);
      const open = ctx.indexer.issueNonce({
        txHash: second.txHash,
        logIndex: second.logIndex,
        wallet: second.wallet,
        issueTime: second.blockTimestamp + 10,
      });
      assert.equal(open.ok, true);
      const again = ctx.indexer.issueNonce({
        txHash: second.txHash,
        logIndex: second.logIndex,
        wallet: second.wallet,
        issueTime: second.blockTimestamp + 11,
      });
      assert.equal(again.reason, "nonce_open");
      const crossed = await signLink(ctx.payer, {
        escrowId: first.escrowId,
        action: first.action,
        txHash: first.txHash,
        logIndex: first.logIndex,
        nonce: open.nonce,
        expiry: second.blockTimestamp + 60,
        wallet: second.wallet,
      });
      const mismatch = ctx.indexer.submitLink({
        nonce: open.nonce,
        escrowId: first.escrowId,
        action: first.action,
        txHash: first.txHash,
        logIndex: first.logIndex,
        expiry: second.blockTimestamp + 60,
        wallet: second.wallet,
        signature: crossed,
      });
      assert.equal(mismatch.reason, "binding_mismatch");
      assert.equal(mismatch.stored, false);
      const wrongWallet = ctx.indexer.issueNonce({
        txHash: second.txHash,
        logIndex: second.logIndex,
        wallet: ctx.payee.address,
        issueTime: second.blockTimestamp + 12,
      });
      assert.equal(wrongWallet.reason, "wallet_mismatch");
      assert.equal(ctx.indexer.revokeNonce(open.nonce).ok, true);
      assert.equal((await creditCandidate(ctx.indexer, ctx.payer, second)).link.ok, true);
      assert.equal(rows(ctx.indexer, ACTION.fund).length, 2);
    } finally {
      ctx.close();
    }
  });

  it("revokes, refuses a late reissue, and accepts one reissue inside the window", async () => {
    const ctx = await prepared();
    try {
      const tooLate = ctx.indexer.issueNonce({
        txHash: ctx.candidate.txHash,
        logIndex: ctx.candidate.logIndex,
        wallet: ctx.candidate.wallet,
        issueTime: ctx.candidate.blockTimestamp + 86401,
      });
      assert.equal(tooLate.reason, "issue_window");
      assert.equal(tooLate.stored, false);
      assert.equal(ctx.indexer.nonceCount(), 0);
      const early = ctx.indexer.issueNonce({
        txHash: ctx.candidate.txHash,
        logIndex: ctx.candidate.logIndex,
        wallet: ctx.candidate.wallet,
        issueTime: ctx.candidate.blockTimestamp + 86000,
      });
      assert.equal(early.ok, true);
      assert.equal(ctx.indexer.revokeNonce(early.nonce).ok, true);
      assert.equal(ctx.indexer.getNonce(early.nonce).status, "revoked");
      const afterWindow = ctx.indexer.issueNonce({
        txHash: ctx.candidate.txHash,
        logIndex: ctx.candidate.logIndex,
        wallet: ctx.candidate.wallet,
        issueTime: ctx.candidate.blockTimestamp + 86401,
      });
      assert.equal(afterWindow.reason, "issue_window");
      assert.equal(ctx.indexer.nonceCount(), 1);
      const again = ctx.indexer.issueNonce({
        txHash: ctx.candidate.txHash,
        logIndex: ctx.candidate.logIndex,
        wallet: ctx.candidate.wallet,
        issueTime: ctx.candidate.blockTimestamp + 3600,
      });
      assert.equal(again.ok, true);
      const stale = await signLink(ctx.payer, {
        escrowId: ctx.candidate.escrowId,
        action: ctx.candidate.action,
        txHash: ctx.candidate.txHash,
        logIndex: ctx.candidate.logIndex,
        nonce: early.nonce,
        expiry: ctx.candidate.blockTimestamp + 60,
        wallet: ctx.candidate.wallet,
      });
      ctx.indexer.setOrigin(ctx.payer.address, { actorType: "human", identityAnchor: true, behavioralSignals: true, modelVersion: "" });
      const rejected = ctx.indexer.submitLink({
        nonce: early.nonce,
        escrowId: ctx.candidate.escrowId,
        action: ctx.candidate.action,
        txHash: ctx.candidate.txHash,
        logIndex: ctx.candidate.logIndex,
        expiry: ctx.candidate.blockTimestamp + 60,
        wallet: ctx.candidate.wallet,
        signature: stale,
      });
      assert.equal(rejected.reason, "nonce_consumed");
      assert.equal(rows(ctx.indexer).length, 0);
      const signature = await signLink(ctx.payer, {
        escrowId: ctx.candidate.escrowId,
        action: ctx.candidate.action,
        txHash: ctx.candidate.txHash,
        logIndex: ctx.candidate.logIndex,
        nonce: again.nonce,
        expiry: ctx.candidate.blockTimestamp,
        wallet: ctx.candidate.wallet,
      });
      const chain = await import("./support.mjs").then(({ signedEntry }) => signedEntry);
      const propose = await chain(ctx.payer, { actorType: "human", authority: "propose", timestamp: ctx.timestamp - 2 });
      const approve = await chain(ctx.payer, { actorType: "human", authority: "approve", timestamp: ctx.timestamp - 1 });
      ctx.indexer.submitChain({ wallet: ctx.payer.address, action: ctx.candidate.action, escrowId: ctx.candidate.escrowId, entries: [propose, approve] });
      const confirmed = ctx.indexer.submitLink({
        nonce: again.nonce,
        escrowId: ctx.candidate.escrowId,
        action: ctx.candidate.action,
        txHash: ctx.candidate.txHash,
        logIndex: ctx.candidate.logIndex,
        expiry: ctx.candidate.blockTimestamp,
        wallet: ctx.candidate.wallet,
        signature,
      });
      assert.equal(confirmed.ok, true);
      const replay = ctx.indexer.submitLink({
        nonce: again.nonce,
        escrowId: ctx.candidate.escrowId,
        action: ctx.candidate.action,
        txHash: ctx.candidate.txHash,
        logIndex: ctx.candidate.logIndex,
        expiry: ctx.candidate.blockTimestamp,
        wallet: ctx.candidate.wallet,
        signature,
      });
      assert.equal(replay.reason, "nonce_consumed");
      assert.equal(rows(ctx.indexer, ACTION.fund).length, 1);
      const reissue = ctx.indexer.issueNonce({
        txHash: ctx.candidate.txHash,
        logIndex: ctx.candidate.logIndex,
        wallet: ctx.candidate.wallet,
        issueTime: ctx.candidate.blockTimestamp + 100,
      });
      assert.equal(reissue.ok, true);
      const secondSig = await signLink(ctx.payer, {
        escrowId: ctx.candidate.escrowId,
        action: ctx.candidate.action,
        txHash: ctx.candidate.txHash,
        logIndex: ctx.candidate.logIndex,
        nonce: reissue.nonce,
        expiry: ctx.candidate.blockTimestamp + 86400,
        wallet: ctx.candidate.wallet,
      });
      const second = ctx.indexer.submitLink({
        nonce: reissue.nonce,
        escrowId: ctx.candidate.escrowId,
        action: ctx.candidate.action,
        txHash: ctx.candidate.txHash,
        logIndex: ctx.candidate.logIndex,
        expiry: ctx.candidate.blockTimestamp + 86400,
        wallet: ctx.candidate.wallet,
        signature: secondSig,
      });
      assert.equal(second.committed, true);
      assert.notEqual(second.ok, true);
      assert.equal(rows(ctx.indexer, ACTION.fund).length, 1);
      const canonical = ctx.indexer.canonical();
      ctx.indexer.rebuild();
      assert.equal(ctx.indexer.canonical(), canonical);
      assert.equal(ctx.indexer.getNonce(early.nonce).status, "revoked");
      assert.equal(ctx.indexer.getNonce(again.nonce).status, "confirmed");
    } finally {
      ctx.close();
    }
  });

  it("judges expiry only against the block timestamp", async () => {
    const ctx = await prepared();
    try {
      const { signedEntry } = await import("./support.mjs");
      ctx.indexer.setOrigin(ctx.payer.address, { actorType: "human", identityAnchor: true, behavioralSignals: true, modelVersion: "" });
      const propose = await signedEntry(ctx.payer, { actorType: "human", authority: "propose", timestamp: ctx.timestamp - 2 });
      const approve = await signedEntry(ctx.payer, { actorType: "human", authority: "approve", timestamp: ctx.timestamp - 1 });
      ctx.indexer.submitChain({
        wallet: ctx.payer.address,
        action: ctx.candidate.action,
        escrowId: ctx.candidate.escrowId,
        entries: [propose, approve],
      });
      const issued = ctx.indexer.issueNonce({
        txHash: ctx.candidate.txHash,
        logIndex: ctx.candidate.logIndex,
        wallet: ctx.candidate.wallet,
        issueTime: ctx.candidate.blockTimestamp + 3600,
      });
      assert.equal(issued.ok, true);
      for (const expiryOffset of [-1, 86401]) {
        const signature = await signLink(ctx.payer, {
          escrowId: ctx.candidate.escrowId,
          action: ctx.candidate.action,
          txHash: ctx.candidate.txHash,
          logIndex: ctx.candidate.logIndex,
          nonce: issued.nonce,
          expiry: ctx.candidate.blockTimestamp + expiryOffset,
          wallet: ctx.candidate.wallet,
        });
        const result = ctx.indexer.submitLink({
          nonce: issued.nonce,
          escrowId: ctx.candidate.escrowId,
          action: ctx.candidate.action,
          txHash: ctx.candidate.txHash,
          logIndex: ctx.candidate.logIndex,
          expiry: ctx.candidate.blockTimestamp + expiryOffset,
          wallet: ctx.candidate.wallet,
          signature,
        });
        assert.equal(result.reason, "expiry");
        assert.equal(result.stored, false);
      }
      assert.equal(rows(ctx.indexer).length, 0);
      const signature = await signLink(ctx.payer, {
        escrowId: ctx.candidate.escrowId,
        action: ctx.candidate.action,
        txHash: ctx.candidate.txHash,
        logIndex: ctx.candidate.logIndex,
        nonce: issued.nonce,
        expiry: ctx.candidate.blockTimestamp + 86400,
        wallet: ctx.candidate.wallet,
      });
      const edge = ctx.indexer.submitLink({
        nonce: issued.nonce,
        escrowId: ctx.candidate.escrowId,
        action: ctx.candidate.action,
        txHash: ctx.candidate.txHash,
        logIndex: ctx.candidate.logIndex,
        expiry: ctx.candidate.blockTimestamp + 86400,
        wallet: ctx.candidate.wallet,
        signature,
      });
      assert.equal(edge.ok, true);
      const canonical = ctx.indexer.canonical();
      ctx.indexer.rebuild();
      assert.equal(ctx.indexer.canonical(), canonical);
    } finally {
      ctx.close();
    }
  });
});

describe("signature bounds", () => {
  it("normalizes v, rejects high s, zero r/s, r at the curve order, and ERC-1271 blobs", async () => {
    const ctx = await prepared();
    try {
      const good = await creditCandidate(ctx.indexer, ctx.payer, ctx.candidate);
      assert.equal(good.link.ok, true);
      const nonce = good.issued.nonce;
      const signature = await signLink(ctx.payer, {
        escrowId: ctx.candidate.escrowId,
        action: ctx.candidate.action,
        txHash: ctx.candidate.txHash,
        logIndex: ctx.candidate.logIndex,
        nonce,
        expiry: ctx.candidate.blockTimestamp + 60,
        wallet: ctx.candidate.wallet,
      });
      const inspected = inspectSignature(signature);
      assert.equal(inspected.ok, true);
      const lowV = `${signature.slice(0, 130)}${(inspected.v - 27).toString(16).padStart(2, "0")}`;
      const hash = hashTypedData({
        domain: POINTS_DOMAIN,
        types: POINTS_LINK_TYPES,
        primaryType: "PointsLink",
        message: {
          escrowId: ctx.candidate.escrowId,
          action: ctx.candidate.action,
          txHash: ctx.candidate.txHash,
          logIndex: BigInt(ctx.candidate.logIndex),
          nonce: BigInt(nonce),
          expiry: BigInt(ctx.candidate.blockTimestamp + 60),
          wallet: getAddress(ctx.candidate.wallet),
        },
      });
      assert.equal(recoverSigner(hash, signature).address, recoverSigner(hash, lowV).address);
      const highS = SECP256K1_N - inspected.s;
      const malleated = `0x${inspected.r.toString(16).padStart(64, "0")}${highS.toString(16).padStart(64, "0")}${(inspected.v === 27 ? 28 : 27).toString(16)}`;
      assert.equal(inspectSignature(malleated).reason, "bad_s");
      assert.equal(inspectSignature(`0x${"00".repeat(32)}${"00".repeat(32)}1b`).reason, "bad_r");
      assert.equal(inspectSignature(`0x${"11".repeat(32)}${"00".repeat(32)}1b`).reason, "bad_s");
      assert.equal(inspectSignature(`0x${SECP256K1_N.toString(16)}${1n.toString(16).padStart(64, "0")}1b`).reason, "bad_r");
      assert.equal(inspectSignature(`0x${1n.toString(16).padStart(64, "0")}${(SECP256K1_HALF_N + 1n).toString(16).padStart(64, "0")}1b`).reason, "bad_s");
      assert.equal(inspectSignature(`${signature.slice(0, 130)}1d`).reason, "bad_v");
      assert.equal(inspectSignature(`${signature.slice(0, 130)}02`).reason, "bad_v");
      assert.equal(inspectSignature(`0x${"ab".repeat(80)}`).reason, "erc1271_refused");
      const blob = ctx.indexer.submitLink({
        nonce: "1",
        escrowId: ctx.candidate.escrowId,
        action: ctx.candidate.action,
        txHash: ctx.candidate.txHash,
        logIndex: ctx.candidate.logIndex,
        expiry: ctx.candidate.blockTimestamp + 60,
        wallet: ctx.candidate.wallet,
        signature: `0x${"ab".repeat(80)}`,
      });
      assert.equal(blob.reason, "erc1271_refused");
      assert.equal(blob.stored, false);
      const other = account();
      const foreign = await signLink(other, {
        escrowId: ctx.candidate.escrowId,
        action: ctx.candidate.action,
        txHash: ctx.candidate.txHash,
        logIndex: ctx.candidate.logIndex,
        nonce,
        expiry: ctx.candidate.blockTimestamp + 60,
        wallet: ctx.candidate.wallet,
      });
      const foreignResult = ctx.indexer.submitLink({
        nonce,
        escrowId: ctx.candidate.escrowId,
        action: ctx.candidate.action,
        txHash: ctx.candidate.txHash,
        logIndex: ctx.candidate.logIndex,
        expiry: ctx.candidate.blockTimestamp + 60,
        wallet: ctx.candidate.wallet,
        signature: foreign,
      });
      assert.equal(foreignResult.reason, "signer_mismatch");
      const wrongDomain = await signLink(ctx.payer, {
        escrowId: ctx.candidate.escrowId,
        action: ctx.candidate.action,
        txHash: ctx.candidate.txHash,
        logIndex: ctx.candidate.logIndex,
        nonce,
        expiry: ctx.candidate.blockTimestamp + 60,
        wallet: ctx.candidate.wallet,
        domain: { ...POINTS_DOMAIN, chainId: 8453 },
      });
      const domainResult = ctx.indexer.submitLink({
        nonce,
        escrowId: ctx.candidate.escrowId,
        action: ctx.candidate.action,
        txHash: ctx.candidate.txHash,
        logIndex: ctx.candidate.logIndex,
        expiry: ctx.candidate.blockTimestamp + 60,
        wallet: ctx.candidate.wallet,
        signature: wrongDomain,
      });
      assert.equal(domainResult.reason, "signer_mismatch");
      assert.equal(rows(ctx.indexer, ACTION.fund).length, 1);
    } finally {
      ctx.close();
    }
  });
});

describe("rebuild", () => {
  it("reopens the same inputs onto a byte-identical ledger", async () => {
    const { rmSync } = await import("node:fs");
    const ctx = await prepared();
    const path = `${ctx.dir}/ledger.sqlite`;
    try {
      assert.equal((await creditCandidate(ctx.indexer, ctx.payer, ctx.candidate)).link.ok, true);
      const first = ctx.indexer.canonical();
      ctx.indexer.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      ctx.indexer.close();
      const { openIndexer } = await import("../src/indexer.mjs");
      const reopened = openIndexer({ path });
      try {
        assert.equal(reopened.canonical(), first);
        reopened.rebuild();
        assert.equal(reopened.canonical(), first);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(ctx.dir, { recursive: true, force: true });
    }
  });
});
