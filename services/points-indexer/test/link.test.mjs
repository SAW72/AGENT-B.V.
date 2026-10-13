import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { linkHash } from "../src/signature.mjs";
import { account, createdLog, tempIndexer } from "./support.mjs";

const MESSAGE = Object.freeze({
  escrowId: `0x${"11".repeat(32)}`,
  action: "fund",
  txHash: `0x${"22".repeat(32)}`,
  logIndex: "7",
  nonce: "9",
  expiry: 100,
  wallet: "0x1111111111111111111111111111111111111111",
});

describe("PointsLink integer fields", () => {
  it("returns bad_link for hex, negative, empty, whitespace, and non-numeric nonce or logIndex", () => {
    assert.equal(typeof linkHash(MESSAGE), "string");
    assert.equal(typeof linkHash({ ...MESSAGE, logIndex: 7, nonce: 9n }), "string");
    const samples = [
      ["hex", "0x10"],
      ["negative", "-1"],
      ["empty", ""],
      ["whitespace", " "],
      ["whitespace", " 1"],
      ["whitespace", "1 "],
      ["non-numeric", "abc"],
      ["non-numeric", "1.2"],
    ];
    for (const [kind, value] of samples) {
      const nonce = linkHash({ ...MESSAGE, nonce: value });
      const logIndex = linkHash({ ...MESSAGE, logIndex: value });
      assert.equal(nonce.reason, "bad_link", `${kind} nonce ${JSON.stringify(value)}`);
      assert.equal(logIndex.reason, "bad_link", `${kind} logIndex ${JSON.stringify(value)}`);
      assert.equal(nonce.ok, false);
      assert.equal(logIndex.ok, false);
    }
  });

  it("does not throw when submitLink receives a non-decimal nonce", () => {
    const payer = account();
    const payee = account();
    const timestamp = 21_300 * 86400 + 8;
    const log = createdLog({
      escrowId: `0x${"31".repeat(32)}`,
      payer: payer.address,
      payee: payee.address,
      expiresAt: timestamp + 50,
      blockNumber: 49_300_001,
      logIndex: 1,
      txHash: `0x${"32".repeat(32)}`,
      timestamp,
    });
    const ctx = tempIndexer();
    try {
      ctx.indexer.ingestLogs([log]);
      for (const nonce of ["0x10", "-1", " ", "abc"]) {
        const result = ctx.indexer.submitLink({
          nonce,
          escrowId: `0x${"31".repeat(32)}`,
          action: "fund",
          txHash: log.transactionHash,
          logIndex: 1,
          expiry: timestamp,
          wallet: payer.address,
          signature: `0x${"ab".repeat(65)}`,
        });
        assert.equal(result.reason, "bad_link", JSON.stringify(nonce));
        assert.equal(result.stored, false);
        assert.equal(result.ok, false);
      }
      const blank = ctx.indexer.submitLink({
        nonce: "",
        escrowId: `0x${"31".repeat(32)}`,
        action: "fund",
        txHash: log.transactionHash,
        logIndex: 1,
        expiry: timestamp,
        wallet: payer.address,
        signature: `0x${"ab".repeat(65)}`,
      });
      assert.equal(blank.reason, "nonce_unknown");
      assert.equal(blank.stored, false);
    } finally {
      ctx.close();
    }
  });
});
