import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { domainSeparator, getAddress, keccak256, toBytes } from "viem";
import { ACTION } from "../src/constants.mjs";
import { POINTS_DOMAIN, linkHash, recoverSigner } from "../src/signature.mjs";
import { account, createdLog, creditCandidate, rows, signLink, tempIndexer } from "./support.mjs";

const ESCROW = "0x3d660502D75f1e97b08c110255921b437A3C4C42";
const DOMAIN_SEPARATOR = "0xf37ac5bd3db4a96e9975d479673e3b2fc629bec7db7cbd991848dc52d919336d";
const POINTS_LINK_TYPEHASH = "0x5519b91daa239120803b236ab97d4c62504b6fd1db34062ef22dd988759c18d7";
const SAMPLE_DIGEST = "0x0fc6288a2e9dcea97580b43da262eba1c39dd271f0128ccdc56e179ce2c26478";
const TYPE_STRING = "PointsLink(bytes32 escrowId,string action,bytes32 txHash,uint256 logIndex,uint256 nonce,uint64 expiry,address wallet)";

const SAMPLE = Object.freeze({
  escrowId: `0x${"11".repeat(32)}`,
  action: "fund",
  txHash: `0x${"22".repeat(32)}`,
  logIndex: "7",
  nonce: "9",
  expiry: 100,
  wallet: "0x1111111111111111111111111111111111111111",
});

describe("EIP-712 known answer", () => {
  it("pins the domain separator and the PointsLink typehash", () => {
    assert.equal(getAddress(ESCROW), POINTS_DOMAIN.verifyingContract);
    assert.equal(POINTS_DOMAIN.name, "Agent-BV Points");
    assert.equal(POINTS_DOMAIN.version, "1");
    assert.equal(POINTS_DOMAIN.chainId, 84532);
    assert.equal(domainSeparator({ domain: POINTS_DOMAIN }), DOMAIN_SEPARATOR);
    assert.equal(keccak256(toBytes(TYPE_STRING)), POINTS_LINK_TYPEHASH);
    assert.equal(linkHash(SAMPLE), SAMPLE_DIGEST);
    const wrongContract = domainSeparator({
      domain: { ...POINTS_DOMAIN, verifyingContract: "0x0000000000000000000000000000000000000001" },
    });
    const wrongVersion = domainSeparator({ domain: { ...POINTS_DOMAIN, version: "2" } });
    assert.notEqual(wrongContract, DOMAIN_SEPARATOR);
    assert.notEqual(wrongVersion, DOMAIN_SEPARATOR);
  });

  it("rejects a signature over a wrong verifyingContract or a wrong version", async () => {
    const signer = account();
    const fields = {
      escrowId: SAMPLE.escrowId,
      action: SAMPLE.action,
      txHash: SAMPLE.txHash,
      logIndex: 7,
      nonce: 9,
      expiry: 100,
      wallet: signer.address,
    };
    const digest = linkHash({ ...fields, logIndex: "7", nonce: "9" });
    assert.equal(typeof digest, "string");
    for (const domain of [
      { ...POINTS_DOMAIN, verifyingContract: "0x0000000000000000000000000000000000000001" },
      { ...POINTS_DOMAIN, version: "2" },
    ]) {
      const signature = await signLink(signer, { ...fields, domain });
      const recovered = recoverSigner(digest, signature);
      assert.equal(recovered.ok, true);
      assert.notEqual(recovered.address, signer.address.toLowerCase());
    }
  });
});

describe("delegated EOA signatures", () => {
  it("accepts ECDSA from the EOA key and refuses contract-code signatures", async () => {
    // EIP-7702 delegation designation. The indexer does not read account code.
    const delegation = `0xef0100${"ab".repeat(20)}`;
    const eoa = account();
    const payee = account();
    const timestamp = 21_500 * 86400 + 12;
    const log = createdLog({
      escrowId: `0x${"e1".repeat(32)}`,
      payer: eoa.address,
      payee: payee.address,
      expiresAt: timestamp + 80,
      blockNumber: 49_500_001,
      logIndex: 2,
      txHash: `0x${"e2".repeat(32)}`,
      timestamp,
    });
    const ctx = tempIndexer();
    try {
      ctx.indexer.ingestLogs([log]);
      const candidate = ctx.indexer.attribute().candidates[0];
      const credited = await creditCandidate(ctx.indexer, eoa, candidate);
      assert.equal(credited.link.ok, true);
      assert.equal(rows(ctx.indexer, ACTION.fund)[0].wallet, eoa.address.toLowerCase());
      const digest = linkHash({
        escrowId: candidate.escrowId,
        action: candidate.action,
        txHash: candidate.txHash,
        logIndex: String(candidate.logIndex),
        nonce: credited.issued.nonce,
        expiry: candidate.blockTimestamp + 60,
        wallet: candidate.wallet,
      });
      assert.equal(recoverSigner(digest, delegation).reason, "erc1271_refused");
      const contractBlob = `0x${"11".repeat(80)}`;
      assert.equal(recoverSigner(digest, contractBlob).reason, "erc1271_refused");
      const refused = ctx.indexer.submitLink({
        nonce: credited.issued.nonce,
        escrowId: candidate.escrowId,
        action: candidate.action,
        txHash: candidate.txHash,
        logIndex: candidate.logIndex,
        expiry: candidate.blockTimestamp + 60,
        wallet: candidate.wallet,
        signature: contractBlob,
      });
      assert.equal(refused.reason, "erc1271_refused");
      assert.equal(refused.stored, false);
      assert.equal(rows(ctx.indexer, ACTION.fund).length, 1);
    } finally {
      ctx.close();
    }
  });
});
