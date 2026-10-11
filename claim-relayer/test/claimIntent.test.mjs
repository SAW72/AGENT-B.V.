import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { hashDomain, keccak256, toBytes, toHex } from "viem";
import { CLAIM_INTENT_SCHEMA, CLAIM_INTENT_TYPE_STRING, CLAIM_INTENT_TYPEHASH, LEGACY_DOMAIN_NAME, actionIndex, actionName, isReleaseAlias, parseClaimIntent } from "../claimIntent.mjs";

/** Pinned EIP-712 typehash for ClaimIntent. A schema edit must change this on purpose. */
const PINNED_TYPEHASH = "0x1f13fdcc6f1390de5e43ffa26909f5e100cb78aaa1cf33d9abdf7d71a4cde0d2";
const DOMAIN_NAME_BYTES = "0x4167656e742d42562052656c61796572";
const CURRENT_DOMAIN_SEPARATOR = "0x25ac3f837af8762d4769d04a046e12858b0bbbd43683dd1e7e561d85030d8c64";
const LEGACY_DOMAIN_SEPARATOR = "0x86ccc7c40c6ac58cd64d4005172763a6ffc8f862dd35436ee829cb9f98040a96";
const BOOKED_ESCROW = "0x3d660502D75f1e97b08c110255921b437A3C4C42";

function domainSeparator(name) {
  return hashDomain({
    domain: {
      name,
      version: CLAIM_INTENT_SCHEMA.domainVersion,
      chainId: 84532,
      verifyingContract: BOOKED_ESCROW,
    },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
    },
  });
}

describe("ClaimIntent typehash", () => {
  it("pins the EIP-712 type string and typehash", () => {
    assert.equal(
      CLAIM_INTENT_TYPE_STRING,
      "ClaimIntent(uint8 action,bytes32 escrowId,address sender,uint256 nonce,uint256 deadline)",
    );
    assert.equal(CLAIM_INTENT_TYPEHASH, keccak256(toBytes(CLAIM_INTENT_TYPE_STRING)));
    assert.equal(CLAIM_INTENT_TYPEHASH, PINNED_TYPEHASH);
    assert.equal(CLAIM_INTENT_SCHEMA.domainName, "Agent-BV Relayer");
    assert.equal(toHex(toBytes(CLAIM_INTENT_SCHEMA.domainName)), DOMAIN_NAME_BYTES);
    assert.equal(toBytes(CLAIM_INTENT_SCHEMA.domainName).length, 16);
    assert.equal(LEGACY_DOMAIN_NAME, "AgentBV Claim Relayer");
    assert.notEqual(LEGACY_DOMAIN_NAME, CLAIM_INTENT_SCHEMA.domainName);
    assert.equal(domainSeparator(CLAIM_INTENT_SCHEMA.domainName), CURRENT_DOMAIN_SEPARATOR);
    assert.equal(domainSeparator(LEGACY_DOMAIN_NAME), LEGACY_DOMAIN_SEPARATOR);
    assert.equal(CLAIM_INTENT_SCHEMA.domainVersion, "1");
    assert.deepEqual(CLAIM_INTENT_SCHEMA.actions, ["refund"]);
    assert.deepEqual(CLAIM_INTENT_SCHEMA.actionValues, { refund: 1 });
    assert.deepEqual(CLAIM_INTENT_SCHEMA.refusedActions, { release: 0 });
    assert.equal(actionIndex("refund"), 1);
    assert.equal(actionIndex(1), 1);
    assert.equal(actionName(1), "refund");
    assert.equal(actionIndex("release"), 0);
    assert.equal(actionIndex(0), 0);
    assert.equal(actionName(0), "release");
    assert.equal(CLAIM_INTENT_SCHEMA.actions.includes("release"), false);
    assert.equal(CLAIM_INTENT_SCHEMA.typeString.includes("calldata"), false);
    assert.equal(CLAIM_INTENT_SCHEMA.deadlineWindowSeconds, 300);
  });

  it("refuses release aliases before a signature is read", () => {
    for (const action of ["release", "Release", " RELEASE ", "0", "00", " 0", 0, 0n]) {
      assert.equal(isReleaseAlias(action), true);
      assert.throws(
        () => parseClaimIntent({ intent: { action } }),
        (err) => err.status === 400 && err.error === "release_not_relayable" && err.txHash === null,
      );
    }
    assert.equal(isReleaseAlias("0x0"), false);
    assert.equal(isReleaseAlias("1"), false);
    assert.equal(isReleaseAlias(1), false);
    assert.throws(
      () => parseClaimIntent({ intent: { action: "0x0" } }),
      (err) => err.status === 400 && err.error === "invalid_signature",
    );
  });

  it("rejects array and object actions before a signature is read", () => {
    for (const action of [[], {}, ["release"], { name: "release" }]) {
      assert.equal(actionName(action), null);
      assert.equal(actionIndex(action), null);
      assert.throws(
        () => parseClaimIntent({ intent: { action } }),
        (err) => err.status === 400 && err.error === "action_not_claim" && err.field === "action",
      );
    }
  });

  it("loads the same JSON bytes the wallet reads", () => {
    const fromDisk = readFileSync(new URL("../claimIntent.json", import.meta.url), "utf8");
    assert.deepEqual(JSON.parse(fromDisk), CLAIM_INTENT_SCHEMA);
    assert.equal(fromDisk.includes("Agent-BV Relayer"), true);
    assert.equal(fromDisk.includes("AgentBV Claim Relayer"), false);
  });
});
