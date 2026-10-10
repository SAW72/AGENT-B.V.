import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  LEGACY_DOMAIN_NAME,
  assertIntentSigner,
  claimIntentDomain,
  claimIntentTypes,
  nonceKey,
  parseClaimIntent,
} from "../claimIntent.mjs";
import { createMemoryIntentNonceStore } from "../intentNonceStore.mjs";
import { prepareLiveClaim } from "../liveAuth.mjs";

const ESCROW = "0x3d660502D75f1e97b08c110255921b437A3C4C42";
const ESCROW_ID = `0x${"ab".repeat(32)}`;
const NOW_SECONDS = 1_700_000_000;
const NOW_MS = NOW_SECONDS * 1000;
const OTHER_DOMAIN_NAME = "Other Relayer";

function config(acceptLegacy) {
  return {
    chainId: 84532,
    escrowAddress: ESCROW,
    erc1271Enabled: false,
    acceptLegacyDomainName: acceptLegacy,
    abuse: { gasPriceWei: "1000000000" },
  };
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

async function signedBody(account, name, nonce) {
  const domain = { ...claimIntentDomain(84532, ESCROW), name };
  const message = {
    action: 1,
    escrowId: ESCROW_ID,
    sender: account.address,
    nonce,
    deadline: BigInt(NOW_SECONDS + 240),
  };
  const signature = await account.signTypedData({
    domain,
    types: claimIntentTypes(),
    primaryType: "ClaimIntent",
    message,
  });
  return {
    live: true,
    signature,
    intent: {
      action: "refund",
      escrowId: ESCROW_ID,
      sender: account.address,
      nonce: nonce.toString(),
      deadline: String(NOW_SECONDS + 240),
      chainId: 84532,
      verifyingContract: ESCROW,
    },
  };
}

function claim(store, body, acceptLegacy) {
  return prepareLiveClaim({
    body,
    config: config(acceptLegacy),
    chain: chainFor(body.intent.sender),
    intentNonces: store,
    abuse,
    nowMs: NOW_MS,
    ip: "203.0.113.9",
  });
}

describe("ClaimIntent domain name transition", () => {
  const account = privateKeyToAccount(generatePrivateKey());

  it("recovers the current name, the previous name only when the flag is on, and no other name", async () => {
    const current = await signedBody(account, "Agent-BV Relayer", 11n);
    const legacy = await signedBody(account, LEGACY_DOMAIN_NAME, 12n);
    const other = await signedBody(account, OTHER_DOMAIN_NAME, 13n);

    const currentSigner = await assertIntentSigner(parseClaimIntent(current), config(true), null);
    assert.equal(currentSigner.domainMatched, "current");
    const currentOff = await assertIntentSigner(parseClaimIntent(current), config(false), null);
    assert.equal(currentOff.domainMatched, "current");

    const legacyOn = await assertIntentSigner(parseClaimIntent(legacy), config(true), null);
    assert.equal(legacyOn.domainMatched, "legacy");
    await assert.rejects(
      () => assertIntentSigner(parseClaimIntent(legacy), config(false), null),
      (err) => err.status === 401 && err.error === "invalid_signature",
    );
    const defaultOn = await assertIntentSigner(
      parseClaimIntent(legacy),
      { chainId: 84532, escrowAddress: ESCROW, erc1271Enabled: false },
      null,
    );
    assert.equal(defaultOn.domainMatched, "legacy");

    for (const acceptLegacy of [true, false]) {
      await assert.rejects(
        () => assertIntentSigner(parseClaimIntent(other), config(acceptLegacy), null),
        (err) => err.status === 401 && err.error === "invalid_signature",
      );
    }
  });

  it("rejects a replay of the same sender and nonce across the two domain names", async () => {
    const nonce = 21n;
    const current = await signedBody(account, "Agent-BV Relayer", nonce);
    const legacy = await signedBody(account, LEGACY_DOMAIN_NAME, nonce);
    assert.equal(nonceKey(account.address, nonce).includes("Agent"), false);
    assert.equal(nonceKey(account.address, nonce), `${account.address.toLowerCase()}:${nonce.toString()}`);

    const forward = createMemoryIntentNonceStore({ now: () => NOW_MS });
    const first = await claim(forward, current, true);
    assert.equal(first.domainMatched, "current");
    await forward.commit(first.nonceKey, { status: 200, body: { ok: true } });
    await assert.rejects(
      () => claim(forward, legacy, true),
      (err) => err.status === 409 && err.error === "nonce_replay",
    );

    const backward = createMemoryIntentNonceStore({ now: () => NOW_MS });
    const oldFirst = await claim(backward, legacy, true);
    assert.equal(oldFirst.domainMatched, "legacy");
    await backward.commit(oldFirst.nonceKey, { status: 200, body: { ok: true } });
    await assert.rejects(
      () => claim(backward, current, true),
      (err) => err.status === 409 && err.error === "nonce_replay",
    );
  });
});
