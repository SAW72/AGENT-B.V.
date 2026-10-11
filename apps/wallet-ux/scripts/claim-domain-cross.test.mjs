import { createMemoryIntentNonceStore } from "../../../claim-relayer/intentNonceStore.mjs";
import {
  LEGACY_DOMAIN_NAME,
  assertIntentSigner,
  parseClaimIntent,
} from "../../../claim-relayer/claimIntent.mjs";
import { prepareLiveClaim } from "../../../claim-relayer/liveAuth.mjs";
import { hashDomain, toBytes, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { CLAIM_INTENT_DOMAIN_NAME, CLAIM_INTENT_DOMAIN_VERSION } from "../src/claimIntent.ts";
import { previewRefund } from "../src/preview.ts";
import { claimSignArgs, signedClaimFromPreview } from "../src/relayer.ts";

const escrow = "0x3d660502D75f1e97b08c110255921b437A3C4C42";
const escrowId = `0x${"ab".repeat(32)}`;
const nowSeconds = 1_700_000_000;
const nowMs = nowSeconds * 1000;
const otherName = "Other Relayer";

const domainTypes = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ],
};

function separator(name) {
  return hashDomain({
    domain: {
      name,
      version: CLAIM_INTENT_DOMAIN_VERSION,
      chainId: 84532,
      verifyingContract: escrow,
    },
    types: domainTypes,
  });
}

function chainFor(sender) {
  return {
    async readEscrow() {
      return { exists: true, payer: sender, payee: sender };
    },
    async simulate() {
      return { ok: true, gasUsed: 21_000n, revertData: null };
    },
  };
}

const abuse = {
  async check() {},
  async consume() {},
};

function relayerConfig(acceptLegacyDomainName) {
  return {
    chainId: 84532,
    escrowAddress: escrow,
    erc1271Enabled: false,
    acceptLegacyDomainName,
    abuse: { gasPriceWei: "1000000000" },
  };
}

describe("wallet and relayer claim domain", () => {
  it("pins the domain name bytes and both domain separators", () => {
    expect(CLAIM_INTENT_DOMAIN_NAME).toBe("Agent-BV Relayer");
    expect(toHex(toBytes(CLAIM_INTENT_DOMAIN_NAME))).toBe("0x4167656e742d42562052656c61796572");
    expect(toBytes(CLAIM_INTENT_DOMAIN_NAME)).toHaveLength(16);
    expect(separator(CLAIM_INTENT_DOMAIN_NAME)).toBe(
      "0x25ac3f837af8762d4769d04a046e12858b0bbbd43683dd1e7e561d85030d8c64",
    );
    expect(separator(LEGACY_DOMAIN_NAME)).toBe(
      "0x86ccc7c40c6ac58cd64d4005172763a6ffc8f862dd35436ee829cb9f98040a96",
    );
    expect(LEGACY_DOMAIN_NAME).toBe("AgentBV Claim Relayer");
  });

  it("verifies a wallet signature with the relayer, including the legacy flag and nonce replay", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const args = claimSignArgs({
      preview: previewRefund(escrow, escrowId),
      sender: account.address,
      verifyingContract: escrow,
      nowSeconds,
      nonce: 21n,
    });
    expect(args.domain.name).toBe(CLAIM_INTENT_DOMAIN_NAME);
    expect(args.domain.name).not.toBe(LEGACY_DOMAIN_NAME);

    const currentSignature = await account.signTypedData(args);
    const legacySignature = await account.signTypedData({
      ...args,
      domain: { ...args.domain, name: LEGACY_DOMAIN_NAME },
    });
    const otherSignature = await account.signTypedData({
      ...args,
      domain: { ...args.domain, name: otherName },
    });
    const currentBody = signedClaimFromPreview({ signature: currentSignature, signArgs: args });
    const legacyBody = signedClaimFromPreview({ signature: legacySignature, signArgs: args });
    const otherBody = signedClaimFromPreview({ signature: otherSignature, signArgs: args });

    const current = await assertIntentSigner(parseClaimIntent(currentBody), relayerConfig(true), null);
    expect(current.domainMatched).toBe("current");
    const legacyOn = await assertIntentSigner(parseClaimIntent(legacyBody), relayerConfig(true), null);
    expect(legacyOn.domainMatched).toBe("legacy");
    await expect(assertIntentSigner(parseClaimIntent(legacyBody), relayerConfig(false), null)).rejects.toMatchObject({
      status: 401,
      error: "invalid_signature",
    });
    await expect(assertIntentSigner(parseClaimIntent(otherBody), relayerConfig(true), null)).rejects.toMatchObject({
      status: 401,
      error: "invalid_signature",
    });
    await expect(assertIntentSigner(parseClaimIntent(otherBody), relayerConfig(false), null)).rejects.toMatchObject({
      status: 401,
      error: "invalid_signature",
    });

    async function claim(store, body) {
      return prepareLiveClaim({
        body,
        config: relayerConfig(true),
        chain: chainFor(account.address),
        intentNonces: store,
        abuse,
        nowMs,
        ip: "203.0.113.10",
      });
    }

    const forward = createMemoryIntentNonceStore({ now: () => nowMs });
    const first = await claim(forward, currentBody);
    expect(first.domainMatched).toBe("current");
    await forward.commit(first.nonceKey, { status: 200, body: { ok: true } });
    await expect(claim(forward, legacyBody)).rejects.toMatchObject({ status: 409, error: "nonce_replay" });

    const backwardArgs = claimSignArgs({
      preview: previewRefund(escrow, escrowId),
      sender: account.address,
      verifyingContract: escrow,
      nowSeconds,
      nonce: 22n,
    });
    const backwardCurrent = signedClaimFromPreview({
      signature: await account.signTypedData(backwardArgs),
      signArgs: backwardArgs,
    });
    const backwardLegacy = signedClaimFromPreview({
      signature: await account.signTypedData({
        ...backwardArgs,
        domain: { ...backwardArgs.domain, name: LEGACY_DOMAIN_NAME },
      }),
      signArgs: backwardArgs,
    });
    const backward = createMemoryIntentNonceStore({ now: () => nowMs });
    const oldFirst = await claim(backward, backwardLegacy);
    expect(oldFirst.domainMatched).toBe("legacy");
    await backward.commit(oldFirst.nonceKey, { status: 200, body: { ok: true } });
    await expect(claim(backward, backwardCurrent)).rejects.toMatchObject({ status: 409, error: "nonce_replay" });
  });
});
