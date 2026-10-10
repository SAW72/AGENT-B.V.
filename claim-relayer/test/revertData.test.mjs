import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  REVERT_COPY,
  contractRevertCopy,
  extractRevertData,
  MAX_REVERT_DATA_BYTES,
  revertDataFrom,
  sanitizeRevertData,
} from "../revertData.mjs";

const CUSTOM = "0x" + "aabbccdd" + "11".repeat(32);
const KEY = "0x" + "22".repeat(32);

const DISPUTE_VOTES_CAST_TEXT =
  "Filing opens the panel case in the same transaction. Votes cast on another case are not read.";

describe("revert data", () => {
  it("maps DisputeVotesCast to opening the panel case in the same transaction", () => {
    assert.equal(REVERT_COPY.DisputeVotesCast.selector, "0x8aab0a8f");
    assert.equal(REVERT_COPY.DisputeVotesCast.meaning, DISPUTE_VOTES_CAST_TEXT);
    assert.equal(REVERT_COPY.DisputeVotesCast.meaning.includes("already has votes"), false);
    assert.deepEqual(contractRevertCopy("0x8AAB0A8F"), {
      name: "DisputeVotesCast",
      selector: "0x8aab0a8f",
      meaning: DISPUTE_VOTES_CAST_TEXT,
    });
    assert.equal(contractRevertCopy("0x3a0621bd"), null);
    assert.equal(
      REVERT_COPY.DisputePending.meaning,
      "Release stays blocked while the dispute is unresolved or was unwound. A refund before the escrow ends stays blocked until the panel unwinds the deal. A refund also stays blocked when the panel upheld the deal.",
    );
    assert.deepEqual(contractRevertCopy("0xfd29e9e5"), {
      name: "DisputePending",
      selector: "0xfd29e9e5",
      meaning: REVERT_COPY.DisputePending.meaning,
    });
  });

  it("maps ReleaseNotAuthorized selector 0xfe28f476 to the payer or payee sentence", () => {
    const meaning = "Only the payer can release an open escrow; after an upheld dispute, the payer or the payee.";
    assert.equal(REVERT_COPY.ReleaseNotAuthorized.selector, "0xfe28f476");
    assert.equal(REVERT_COPY.ReleaseNotAuthorized.meaning, meaning);
    assert.deepEqual(contractRevertCopy("0xfe28f476"), {
      name: "ReleaseNotAuthorized",
      selector: "0xfe28f476",
      meaning,
    });
    assert.deepEqual(contractRevertCopy("0xFE28F476"), {
      name: "ReleaseNotAuthorized",
      selector: "0xfe28f476",
      meaning,
    });
  });

  it("keeps a custom-error payload as lowercase hex", () => {
    const upper = "0x" + CUSTOM.slice(2).toUpperCase();
    assert.equal(sanitizeRevertData(upper), CUSTOM);
    assert.equal(extractRevertData({ data: upper }), CUSTOM);
    assert.equal(extractRevertData({ raw: "  " + upper + "  " }), CUSTOM);
  });

  it("reads nested error, info.error, cause, and data.data shapes", () => {
    assert.equal(extractRevertData({ error: { data: CUSTOM } }), CUSTOM);
    assert.equal(extractRevertData({ info: { error: { data: CUSTOM, message: "execution reverted" } } }), CUSTOM);
    assert.equal(extractRevertData({ cause: { data: CUSTOM } }), CUSTOM);
    assert.equal(extractRevertData({ cause: { raw: CUSTOM } }), CUSTOM);
    assert.equal(extractRevertData({ data: { data: CUSTOM, message: "execution reverted" } }), CUSTOM);
    assert.equal(
      extractRevertData({
        data: "0xzz",
        cause: { data: "0xabc" },
        info: { error: { data: { data: "0x" + CUSTOM.slice(2).toUpperCase() }, url: "https://rpc.example/secret" } },
      }),
      CUSTOM,
    );
    assert.equal(
      extractRevertData({
        data: { errorName: "NotAParty", args: [] },
        raw: CUSTOM,
        reason: "not a party",
      }),
      CUSTOM,
    );
  });

  it("returns null when no revert bytes are present", () => {
    assert.equal(extractRevertData(new Error("execution reverted")), null);
    assert.equal(extractRevertData({ message: CUSTOM, shortMessage: CUSTOM, url: "https://rpc.example/key" }), null);
    assert.equal(extractRevertData({ data: "0x" }), null);
    assert.equal(extractRevertData(null), null);
    assert.equal(revertDataFrom({ revert_data: null }), null);
  });

  it("rejects non-hex, odd-length, empty, and oversized data", () => {
    assert.equal(sanitizeRevertData("not-hex"), null);
    assert.equal(sanitizeRevertData("0xzz"), null);
    assert.equal(sanitizeRevertData("0X" + "aa".repeat(4)), null);
    assert.equal(sanitizeRevertData("0xabc"), null);
    assert.equal(sanitizeRevertData("0x"), null);
    assert.equal(sanitizeRevertData("0x" + "aa".repeat(MAX_REVERT_DATA_BYTES)), "0x" + "aa".repeat(MAX_REVERT_DATA_BYTES));
    assert.equal(sanitizeRevertData("0x" + "aa".repeat(MAX_REVERT_DATA_BYTES + 1)), null);
    assert.equal(extractRevertData({ data: "nope https://rpc.example/secret-key" }), null);
    assert.equal(extractRevertData({ data: "0xabc" }), null);
    assert.equal(extractRevertData({ raw: "0x" + "bb".repeat(MAX_REVERT_DATA_BYTES + 1) }), null);
    assert.equal(extractRevertData({ data: { data: "0xgg" } }), null);
  });

  it("drops a payload that contains the signer key", () => {
    assert.equal(extractRevertData({ data: KEY }, KEY), null);
    assert.equal(extractRevertData({ data: "0x" + "aa".repeat(4) + KEY.slice(2) }, KEY), null);
    assert.equal(revertDataFrom({ revert_data: KEY }, KEY), null);
    assert.equal(extractRevertData({ data: CUSTOM }, KEY), CUSTOM);
  });
});
