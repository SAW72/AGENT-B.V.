import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  ESCROW_SIGNATURES,
  MAX_DURATION_SECONDS,
  encodeEscrowAction,
  externalSignatureFromSource,
  selectorFor,
} from "../escrowCalldata.mjs";

const ESCROW_ID = "0x" + "11".repeat(32);
const PAYEE = "0x2222222222222222222222222222222222222222";
const PAYER_BOT = "0x" + "22".repeat(32);
const PAYEE_BOT = "0x" + "33".repeat(32);

describe("escrow calldata", () => {
  it("matches keccak selectors for known Solidity signatures", () => {
    assert.equal(selectorFor("owner()"), "0x8da5cb5b");
    assert.equal(selectorFor("transfer(address,uint256)"), "0xa9059cbb");
  });

  it("locks claim signatures to BotAttestationEscrow.sol", async () => {
    const source = await readFile(new URL("../../contracts/BotAttestationEscrow.sol", import.meta.url), "utf8");
    for (const signature of Object.values(ESCROW_SIGNATURES)) {
      const name = signature.slice(0, signature.indexOf("("));
      assert.equal(externalSignatureFromSource(source, name), signature);
    }
    assert.match(source, /function release\(\s*bytes32 escrowId\s*\)/);
    assert.match(source, /function refund\(\s*bytes32 escrowId\s*\)/);
    assert.match(source, /function dispute\(\s*bytes32 escrowId,\s*bytes32 disputeId,\s*string calldata reason\s*\)/);
    assert.match(source, /durationSeconds > 30 days/);
    assert.match(source, /IDisputePanel public disputePanel/);
    assert.match(source, /address public immutable governance/);
    assert.equal(MAX_DURATION_SECONDS, 2_592_000n);
  });

  it("encodes release and refund as a single bytes32 word and no value", () => {
    const release = encodeEscrowAction({ action: "release", escrowId: ESCROW_ID });
    assert.equal(release.signature, "release(bytes32)");
    assert.equal(release.selector, selectorFor("release(bytes32)"));
    assert.equal(release.calldata, release.selector + ESCROW_ID.slice(2));
    assert.equal(release.valueWei, "0");
    assert.equal(release.senderConstraint, "payer_while_open");
    assert.equal(encodeEscrowAction({ action: "refund", escrowId: ESCROW_ID }).senderConstraint, "permissionless");

    const refund = encodeEscrowAction({ action: "refund", claimId: ESCROW_ID });
    assert.equal(refund.calldata.slice(0, 10), selectorFor("refund(bytes32)"));
    assert.equal(refund.calldata.slice(10), ESCROW_ID.slice(2));
  });

  it("encodes createEscrow with msg.value outside the calldata", () => {
    const encoded = encodeEscrowAction({
      action: "createEscrow",
      escrowId: ESCROW_ID,
      payee: PAYEE,
      payerBotId: PAYER_BOT,
      payeeBotId: PAYEE_BOT,
      durationSeconds: "3600",
      amountWei: "1000",
    });
    assert.equal(encoded.selector, selectorFor(ESCROW_SIGNATURES.createEscrow));
    assert.equal(encoded.valueWei, "1000");
    assert.equal(encoded.senderConstraint, "vault_operator_must_send");
    const body = encoded.calldata.slice(10);
    assert.equal(body.slice(0, 64), ESCROW_ID.slice(2));
    assert.equal(body.slice(64, 128).slice(24), PAYEE.slice(2).toLowerCase());
    assert.equal(body.slice(128, 192), PAYER_BOT.slice(2));
    assert.equal(body.slice(192, 256), PAYEE_BOT.slice(2));
    assert.equal(BigInt("0x" + body.slice(256)), 3600n);
    const valueWord = 1000n.toString(16).padStart(64, "0");
    assert.equal(body.includes(valueWord), false);
  });

  it("encodes dispute and refuses governance setters and bad durations", () => {
    const reason = "panel case";
    const encoded = encodeEscrowAction({
      action: "dispute",
      escrowId: ESCROW_ID,
      disputeId: "0x" + "44".repeat(32),
      reason,
    });
    assert.equal(encoded.signature, "dispute(bytes32,bytes32,string)");
    assert.equal(encoded.selector, selectorFor("dispute(bytes32,bytes32,string)"));
    assert.equal(encoded.senderConstraint, "party_must_send");
    assert.equal(encoded.valueWei, "0");
    const reasonBytes = Buffer.from(reason, "utf8");
    const paddedWords = Math.ceil(reasonBytes.length / 32);
    assert.equal(encoded.calldata.length, 2 + 8 + 64 * 3 + 64 + paddedWords * 64);
    const body = encoded.calldata.slice(10);
    assert.equal(body.slice(0, 64), ESCROW_ID.slice(2));
    assert.equal(body.slice(64, 128), "44".repeat(32));
    assert.equal(BigInt("0x" + body.slice(128, 192)), 96n);
    assert.equal(BigInt("0x" + body.slice(192, 256)), BigInt(reasonBytes.length));
    assert.equal(Buffer.from(body.slice(256, 256 + reasonBytes.length * 2), "hex").toString("utf8"), reason);
    assert.throws(
      () => encodeEscrowAction({ action: "dispute", escrowId: ESCROW_ID, disputeId: "0x" + "44".repeat(32) }),
      (err) => err.error === "invalid_reason",
    );
    assert.throws(
      () =>
        encodeEscrowAction({
          action: "dispute",
          escrowId: ESCROW_ID,
          disputeId: "0x" + "44".repeat(32),
          reason: "x".repeat(257),
        }),
      (err) => err.error === "reason_too_long",
    );
    assert.throws(() => encodeEscrowAction({ action: "setDenylist", escrowId: ESCROW_ID }), (err) => err.error === "action_not_claim");
    assert.throws(
      () =>
        encodeEscrowAction({
          action: "createEscrow",
          escrowId: ESCROW_ID,
          payee: PAYEE,
          payerBotId: PAYER_BOT,
          payeeBotId: PAYEE_BOT,
          durationSeconds: String(MAX_DURATION_SECONDS + 1n),
          amountWei: "1",
        }),
      (err) => err.error === "invalid_duration",
    );
  });
});
