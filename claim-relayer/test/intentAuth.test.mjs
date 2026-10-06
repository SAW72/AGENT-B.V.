import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { createAbuseGuard } from "../abuseLimits.mjs";
import { createClaimRelayer } from "../app.mjs";
import { RETIRED_ESCROW, nonceKey } from "../claimIntent.mjs";
import { createClaimLog } from "../claimLog.mjs";
import { loadConfig } from "../config.mjs";
import { encodeEscrowAction } from "../escrowCalldata.mjs";
import { createMemoryIntentNonceStore } from "../intentNonceStore.mjs";
import { createKillSwitch } from "../killSwitch.mjs";
import { createNonceStore } from "../nonceStore.mjs";
import { BOOKED_ESCROW, NOW_MS, deadlineAt, signedLiveBody, testAccounts, trackingChain } from "./liveIntent.mjs";

const TX = "0x" + "ab".repeat(32);

function request(port, method, path, body, headers = {}) {
  const payload = body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, json, raw });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function boot(env = {}, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), "intent-auth-"));
  const config = loadConfig({
    CLAIM_LOG_PATH: join(dir, "claims.jsonl"),
    LIVE_SUBMIT: "1",
    SPENCER_RUN_AUTH: "1",
    ...env,
  });
  const sent = [];
  const chain = extra.chain || trackingChain({ exists: false });
  const server = createClaimRelayer({
    config,
    killSwitch: createKillSwitch({ initial: false }),
    nonceStore: createNonceStore(),
    intentNonces: extra.intentNonces || createMemoryIntentNonceStore({ now: () => NOW_MS }),
    abuse: extra.abuse || createAbuseGuard(config.abuse, { now: () => NOW_MS }),
    chain,
    claimLog: createClaimLog({ filePath: join(dir, "claims.jsonl") }),
    broadcaster: extra.broadcaster || {
      async send(tx) {
        sent.push(tx);
        return { txHash: TX };
      },
    },
    now: () => NOW_MS,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    port: server.address().port,
    sent,
    chain,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function releaseBody(account, opts = {}) {
  return signedLiveBody({
    account,
    action: opts.action || "refund",
    escrowId: opts.escrowId || "0x" + "11".repeat(32),
    nonce: opts.nonce || "7",
    deadline: opts.deadline || deadlineAt(120),
    chainId: opts.chainId,
    verifyingContract: opts.verifyingContract,
    calldata: opts.calldata,
    fields: opts.fields,
  });
}

describe("signed claim intent auth", () => {
  const accounts = testAccounts();
  const escrowId = "0x" + "11".repeat(32);

  it("refuses a relayed release before a nonce, a signature, or a broadcast", async () => {
    const chain = trackingChain({ payer: accounts.payer.address, payee: accounts.payee.address });
    const intentNonces = createMemoryIntentNonceStore({ now: () => NOW_MS });
    let claims = 0;
    const claim = intentNonces.claim.bind(intentNonces);
    intentNonces.claim = async (input) => {
      claims += 1;
      return claim(input);
    };
    const rpcMethods = [];
    let signerCalls = 0;
    const sent = [];
    const signer = privateKeyToAccount("0x" + "11".repeat(32));
    const broadcaster = {
      async send(tx) {
        sent.push(tx);
        signerCalls += 1;
        await signer.signTransaction({
          chainId: 84532,
          nonce: 0,
          gas: 21_000n,
          maxFeePerGas: 1n,
          maxPriorityFeePerGas: 1n,
          to: BOOKED_ESCROW,
          value: 0n,
          data: "0x",
          type: "eip1559",
        });
        rpcMethods.push("eth_sendTransaction");
        rpcMethods.push("eth_sendRawTransaction");
        return { txHash: TX };
      },
    };
    const ctx = await boot({}, { chain, intentNonces, broadcaster });
    try {
      const body = await signedLiveBody({
        account: accounts.payer,
        action: "release",
        escrowId,
        nonce: "77",
        deadline: deadlineAt(120),
      });
      const res = await request(ctx.port, "POST", "/v1/claims", body);
      assert.equal(res.status, 400);
      assert.equal(res.json.error, "release_not_relayable");
      assert.equal(res.json.txHash, null);
      assert.equal(claims, 0);
      assert.equal(signerCalls, 0);
      assert.equal(rpcMethods.includes("eth_sendTransaction"), false);
      assert.equal(rpcMethods.includes("eth_sendRawTransaction"), false);
      assert.equal(chain.calls.simulations.length, 0);
      assert.equal(chain.calls.reads.length, 0);
      assert.equal(chain.calls.erc1271.length, 0);
      assert.equal(sent.length, 0);
      assert.deepEqual(await intentNonces.peek(nonceKey(accounts.payer.address, 77n)), { kind: "absent" });

      const again = await request(ctx.port, "POST", "/v1/claims", body);
      assert.equal(again.status, 400);
      assert.equal(again.json.error, "release_not_relayable");
      assert.equal(claims, 0);
      assert.equal(signerCalls, 0);
    } finally {
      await ctx.close();
    }
  });

  it("returns 409 ruling_pending when refund simulation reverts RulingPending and does not broadcast", async () => {
    let sends = 0;
    let sims = 0;
    const chain = trackingChain({
      payer: accounts.payer.address,
      payee: accounts.payee.address,
      simulate: async () => {
        sims += 1;
        if (sims === 1) return { ok: false, gasUsed: 0n, revertData: "0x3a0621bd" };
        return { ok: true, gasUsed: 80_000n };
      },
    });
    const ctx = await boot({}, {
      chain,
      broadcaster: {
        async send() {
          sends += 1;
          return { txHash: TX };
        },
      },
    });
    try {
      const body = await releaseBody(accounts.payer, { nonce: "78" });
      const res = await request(ctx.port, "POST", "/v1/claims", body);
      assert.equal(res.status, 409);
      assert.equal(res.json.error, "ruling_pending");
      assert.equal(res.json.txHash, null);
      assert.equal(res.json.revert_data, "0x3a0621bd");
      assert.equal(sends, 0);
      assert.equal(chain.calls.simulations.length, 1);

      const again = await request(ctx.port, "POST", "/v1/claims", body);
      assert.equal(again.status, 409);
      assert.equal(again.json.error, "nonce_replay");
      assert.equal(again.json.txHash, null);
      assert.equal(sends, 0);

      const fresh = await releaseBody(accounts.payer, { nonce: "178" });
      const ok = await request(ctx.port, "POST", "/v1/claims", fresh);
      assert.equal(ok.status, 200);
      assert.equal(ok.json.txHash, TX);
      assert.equal(sends, 1);
    } finally {
      await ctx.close();
    }
  });

  it("returns 409 ruling_pending when a broadcast reverts RulingPending", async () => {
    const chain = trackingChain({ payer: accounts.payer.address, payee: accounts.payee.address });
    const ctx = await boot({}, {
      chain,
      broadcaster: {
        async send() {
          const err = new Error("execution reverted");
          err.data = "0x3a0621BD";
          throw err;
        },
      },
    });
    try {
      const body = await releaseBody(accounts.payer, { nonce: "79" });
      const res = await request(ctx.port, "POST", "/v1/claims", body);
      assert.equal(res.status, 409);
      assert.equal(res.json.error, "ruling_pending");
      assert.notEqual(res.status, 502);
      assert.equal(res.json.txHash, null);
      assert.equal(res.json.revert_data, "0x3a0621bd");
      assert.equal(chain.calls.simulations.length, 1);
    } finally {
      await ctx.close();
    }
  });

  it("rejects a non-party signature with 403 and does not broadcast", async () => {
    const chain = trackingChain({ payer: accounts.payer.address, payee: accounts.payee.address });
    const ctx = await boot({}, { chain });
    try {
      const body = await releaseBody(accounts.stranger, { nonce: "101" });
      const res = await request(ctx.port, "POST", "/v1/claims", body);
      assert.equal(res.status, 403);
      assert.equal(res.json.error, "not_a_party");
      assert.equal(ctx.sent.length, 0);
      assert.equal(chain.calls.simulations.length, 0);
      assert.equal(chain.calls.reads.length, 1);
    } finally {
      await ctx.close();
    }
  });

  it("rejects a wrong chain id and the retired escrow before any escrow read", async () => {
    const chain = trackingChain({ payer: accounts.payer.address, payee: accounts.payee.address });
    const ctx = await boot({}, { chain });
    try {
      const wrongChain = await releaseBody(accounts.payer, { nonce: "102", chainId: 1 });
      const chainRes = await request(ctx.port, "POST", "/v1/claims", wrongChain);
      assert.equal(chainRes.status, 400);
      assert.equal(chainRes.json.error, "mainnet_refused");

      const otherChain = await releaseBody(accounts.payer, { nonce: "103", chainId: 11155111 });
      const otherRes = await request(ctx.port, "POST", "/v1/claims", otherChain);
      assert.equal(otherRes.status, 400);
      assert.equal(otherRes.json.error, "wrong_chain");

      const retired = await releaseBody(accounts.payer, { nonce: "104", verifyingContract: RETIRED_ESCROW });
      const retiredRes = await request(ctx.port, "POST", "/v1/claims", retired);
      assert.equal(retiredRes.status, 400);
      assert.equal(retiredRes.json.error, "retired_or_superseded_address");

      const retiredEscM1 = await releaseBody(accounts.payer, {
        nonce: "106",
        verifyingContract: "0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d",
      });
      const retiredEscM1Res = await request(ctx.port, "POST", "/v1/claims", retiredEscM1);
      assert.equal(retiredEscM1Res.status, 400);
      assert.equal(retiredEscM1Res.json.error, "retired_or_superseded_address");

      const otherEscrow = "0x3333333333333333333333333333333333333333";
      const mismatch = await releaseBody(accounts.payer, { nonce: "105", verifyingContract: otherEscrow });
      const mismatchRes = await request(ctx.port, "POST", "/v1/claims", mismatch);
      assert.equal(mismatchRes.status, 409);
      assert.equal(mismatchRes.json.error, "domain_mismatch");
      assert.equal(chain.calls.reads.length, 0);
      assert.equal(ctx.sent.length, 0);
    } finally {
      await ctx.close();
    }
  });

  it("rejects an expired deadline and a deadline past the 300 second window", async () => {
    const chain = trackingChain({ payer: accounts.payer.address, payee: accounts.payee.address });
    const ctx = await boot({}, { chain });
    try {
      const expired = await releaseBody(accounts.payer, { nonce: "106", deadline: deadlineAt(0) });
      const expiredRes = await request(ctx.port, "POST", "/v1/claims", expired);
      assert.equal(expiredRes.status, 400);
      assert.equal(expiredRes.json.error, "deadline_expired");

      const past = await releaseBody(accounts.payer, { nonce: "107", deadline: deadlineAt(-5) });
      const pastRes = await request(ctx.port, "POST", "/v1/claims", past);
      assert.equal(pastRes.status, 400);
      assert.equal(pastRes.json.error, "deadline_expired");

      const far = await releaseBody(accounts.payer, { nonce: "108", deadline: deadlineAt(301) });
      const farRes = await request(ctx.port, "POST", "/v1/claims", far);
      assert.equal(farRes.status, 400);
      assert.equal(farRes.json.error, "deadline_too_far");

      const edge = await releaseBody(accounts.payer, { nonce: "109", deadline: deadlineAt(300) });
      const edgeRes = await request(ctx.port, "POST", "/v1/claims", edge);
      assert.equal(edgeRes.status, 200);
      assert.equal(edgeRes.json.txHash, TX);
      assert.equal(chain.calls.reads.length, 1);
      assert.equal(ctx.sent.length, 1);
    } finally {
      await ctx.close();
    }
  });

  it("rejects a replayed nonce and does not broadcast again", async () => {
    const chain = trackingChain({ payer: accounts.payer.address, payee: accounts.payee.address });
    const ctx = await boot({}, { chain });
    try {
      const body = await releaseBody(accounts.payer, { nonce: "110" });
      const first = await request(ctx.port, "POST", "/v1/claims", body);
      assert.equal(first.status, 200);
      assert.equal(first.json.txHash, TX);
      const second = await request(ctx.port, "POST", "/v1/claims", body);
      assert.equal(second.status, 409);
      assert.equal(second.json.error, "nonce_replay");
      assert.equal(second.json.txHash, null);
      assert.equal(ctx.sent.length, 1);
      assert.equal(chain.calls.simulations.length, 1);
    } finally {
      await ctx.close();
    }
  });

  it("rejects an escrow id mismatch, trailing bytes, and a supplied value", async () => {
    const chain = trackingChain({ payer: accounts.payer.address, payee: accounts.payee.address });
    const ctx = await boot({}, { chain });
    try {
      const otherId = "0x" + "22".repeat(32);
      const mismatched = await releaseBody(accounts.payer, { nonce: "111" });
      mismatched.calldata = encodeEscrowAction({ action: "release", escrowId: otherId }).calldata;
      const mismatch = await request(ctx.port, "POST", "/v1/claims", mismatched);
      assert.equal(mismatch.status, 400);
      assert.equal(mismatch.json.error, "calldata_mismatch");
      assert.equal(chain.calls.reads.length, 0);
      assert.equal(chain.calls.simulations.length, 0);
      assert.equal(ctx.sent.length, 0);

      const trailing = await releaseBody(accounts.payer, { nonce: "112" });
      trailing.calldata = `${trailing.calldata}00`;
      const extra = await request(ctx.port, "POST", "/v1/claims", trailing);
      assert.equal(extra.status, 400);
      assert.equal(extra.json.error, "trailing_bytes");
      assert.equal(ctx.sent.length, 0);

      const valued = await releaseBody(accounts.payer, { nonce: "113" });
      valued.amountWei = "1";
      const value = await request(ctx.port, "POST", "/v1/claims", valued);
      assert.equal(value.status, 400);
      assert.equal(value.json.error, "value_not_allowed");
      assert.equal(chain.calls.reads.length, 0);
      assert.equal(ctx.sent.length, 0);

      const bound = await releaseBody(accounts.payer, { nonce: "114" });
      delete bound.calldata;
      const accepted = await request(ctx.port, "POST", "/v1/claims", bound);
      assert.equal(accepted.status, 200);
      const expected = encodeEscrowAction({ action: "refund", escrowId });
      assert.equal(ctx.sent[0].data.toLowerCase(), expected.calldata.toLowerCase());
      assert.equal(ctx.sent[0].valueWei, "0");
      assert.equal(accepted.json.valueWei, "0");
    } finally {
      await ctx.close();
    }
  });

  it("returns 404 escrow_not_found before simulation when the id does not exist", async () => {
    const chain = trackingChain({ exists: false, payer: accounts.payer.address, payee: accounts.payee.address });
    const ctx = await boot({}, { chain });
    try {
      const body = await releaseBody(accounts.payer, { nonce: "113" });
      const res = await request(ctx.port, "POST", "/v1/claims", body);
      assert.equal(res.status, 404);
      assert.equal(res.json.error, "escrow_not_found");
      assert.equal(chain.calls.simulations.length, 0);
      assert.equal(ctx.sent.length, 0);
    } finally {
      await ctx.close();
    }
  });

  it("checks domain and deadline before signature recovery", async () => {
    const chain = trackingChain({ payer: accounts.payer.address, payee: accounts.payee.address });
    const ctx = await boot({}, { chain });
    try {
      const body = await releaseBody(accounts.payer, { nonce: "114", chainId: 8453 });
      body.signature = "0x" + "11".repeat(65);
      const res = await request(ctx.port, "POST", "/v1/claims", body);
      assert.equal(res.status, 400);
      assert.equal(res.json.error, "mainnet_refused");
      assert.equal(chain.calls.erc1271.length, 0);
      assert.equal(chain.calls.reads.length, 0);
    } finally {
      await ctx.close();
    }
  });

  it("uses ERC-1271 only when the flag is on", async () => {
    const chain = trackingChain({
      payer: accounts.payer.address,
      payee: accounts.payee.address,
      isValidSignature: (account) => account.toLowerCase() === accounts.payer.address.toLowerCase(),
    });
    const off = await boot({}, { chain });
    try {
      const body = await releaseBody(accounts.payer, { nonce: "115" });
      body.signature = "0x" + "22".repeat(80);
      const refused = await request(off.port, "POST", "/v1/claims", body);
      assert.equal(refused.status, 401);
      assert.equal(refused.json.error, "invalid_signature");
      assert.equal(chain.calls.erc1271.length, 0);
      assert.equal(chain.calls.reads.length, 0);
      assert.equal(off.sent.length, 0);
    } finally {
      await off.close();
    }

    const onChain = trackingChain({
      payer: accounts.payer.address,
      payee: accounts.payee.address,
      isValidSignature: (account) => account.toLowerCase() === accounts.payer.address.toLowerCase(),
    });
    const on = await boot({ ERC1271_ENABLED: "1" }, { chain: onChain });
    try {
      const encoded = encodeEscrowAction({ action: "refund", claimId: escrowId });
      const body = await releaseBody(accounts.payer, { nonce: "116", calldata: encoded.calldata });
      body.signature = "0x" + "33".repeat(80);
      const accepted = await request(on.port, "POST", "/v1/claims", body);
      assert.equal(accepted.status, 200);
      assert.equal(accepted.json.txHash, TX);
      assert.equal(onChain.calls.erc1271.length, 1);
      assert.equal(on.sent.length, 1);
    } finally {
      await on.close();
    }
  });

  it("enforces per-sender, per-IP, and per-escrow limits", async () => {
    const chain = trackingChain({ payer: accounts.payer.address, payee: accounts.payee.address });
    const ctx = await boot(
      { CLAIM_RATE_SENDER: "1", CLAIM_RATE_IP: "1", CLAIM_ESCROW_CAP: "1" },
      { chain },
    );
    try {
      const first = await request(
        ctx.port,
        "POST",
        "/v1/claims",
        await releaseBody(accounts.payer, { nonce: "201" }),
      );
      assert.equal(first.status, 200);
      const second = await request(
        ctx.port,
        "POST",
        "/v1/claims",
        await releaseBody(accounts.payer, { nonce: "202" }),
      );
      assert.equal(second.status, 429);
      assert.equal(second.json.error, "rate_limited");
      assert.equal(ctx.sent.length, 1);
    } finally {
      await ctx.close();
    }
  });

  it("stops a second party on the same escrow when the escrow cap is the only limit", async () => {
    const chain = trackingChain({ payer: accounts.payer.address, payee: accounts.payee.address });
    const ctx = await boot({ CLAIM_RATE_SENDER: "10", CLAIM_RATE_IP: "10", CLAIM_ESCROW_CAP: "1" }, { chain });
    try {
      const payer = await request(
        ctx.port,
        "POST",
        "/v1/claims",
        await releaseBody(accounts.payer, { nonce: "301" }),
        { "x-forwarded-for": "203.0.113.10" },
      );
      assert.equal(payer.status, 200);
      const payee = await request(
        ctx.port,
        "POST",
        "/v1/claims",
        await releaseBody(accounts.payee, { nonce: "302", action: "refund" }),
        { "x-forwarded-for": "203.0.113.11" },
      );
      assert.equal(payee.status, 429);
      assert.equal(payee.json.error, "escrow_cap");
      assert.equal(ctx.sent.length, 1);
    } finally {
      await ctx.close();
    }
  });

  it("refuses a claim that would exhaust the daily gas budget", async () => {
    const chain = trackingChain({ payer: accounts.payer.address, payee: accounts.payee.address });
    const ctx = await boot({ DAILY_GAS_BUDGET_WEI: "1", CLAIM_GAS_PRICE_WEI: "1000000000" }, { chain });
    try {
      const res = await request(
        ctx.port,
        "POST",
        "/v1/claims",
        await releaseBody(accounts.payer, { nonce: "401" }),
      );
      assert.equal(res.status, 429);
      assert.equal(res.json.error, "gas_budget_exhausted");
      assert.equal(ctx.sent.length, 0);
    } finally {
      await ctx.close();
    }
  });

  it("keeps the kill switch in front of signature checks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "intent-auth-"));
    const config = loadConfig({
      CLAIM_LOG_PATH: join(dir, "claims.jsonl"),
      LIVE_SUBMIT: "1",
      SPENCER_RUN_AUTH: "1",
      KILL_SWITCH: "1",
    });
    const sent = [];
    const server = createClaimRelayer({
      config,
      killSwitch: createKillSwitch({ initial: true }),
      nonceStore: createNonceStore(),
      intentNonces: createMemoryIntentNonceStore({ now: () => NOW_MS }),
      abuse: createAbuseGuard(config.abuse, { now: () => NOW_MS }),
      chain: trackingChain({ payer: accounts.payer.address, payee: accounts.payee.address }),
      claimLog: createClaimLog({ filePath: join(dir, "claims.jsonl") }),
      broadcaster: {
        async send(tx) {
          sent.push(tx);
          return { txHash: TX };
        },
      },
      now: () => NOW_MS,
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const res = await request(server.address().port, "POST", "/v1/claims", { live: true });
      assert.equal(res.status, 503);
      assert.equal(res.json.error, "kill_switch");
      assert.equal(sent.length, 0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("refuses release aliases, including numeric 0, before signature recovery", async () => {
    const chain = trackingChain({ payer: accounts.payer.address, payee: accounts.payee.address });
    const intentNonces = createMemoryIntentNonceStore({ now: () => NOW_MS });
    const ctx = await boot({}, { chain, intentNonces });
    try {
      let nonce = 80n;
      for (const action of [0, "0", "00", " 0", "Release", " RELEASE "]) {
        const bodyNonce = nonce;
        nonce += 1n;
        const res = await request(ctx.port, "POST", "/v1/claims", {
          live: true,
          intent: { action, sender: accounts.payer.address, nonce: bodyNonce.toString() },
        });
        assert.equal(res.status, 400, JSON.stringify(action));
        assert.equal(res.json.error, "release_not_relayable", JSON.stringify(action));
        assert.equal(res.json.txHash, null);
        assert.deepEqual(await intentNonces.peek(nonceKey(accounts.payer.address, bodyNonce)), { kind: "absent" });
      }
      for (const action of [[], {}, ["release"], { name: "release" }]) {
        const res = await request(ctx.port, "POST", "/v1/claims", { live: true, intent: { action } });
        assert.equal(res.status, 400);
        assert.equal(res.json.error, "action_not_claim");
        assert.equal(res.json.field, "action");
        assert.equal(res.json.txHash, null);
      }
      assert.equal(chain.calls.reads.length, 0);
      assert.equal(chain.calls.erc1271.length, 0);
      assert.equal(chain.calls.simulations.length, 0);
      assert.equal(ctx.sent.length, 0);
    } finally {
      await ctx.close();
    }
  });

  it("rejects createEscrow, dispute, withdraw, and withdrawTo before any chain read", async () => {
    const chain = trackingChain({ payer: accounts.payer.address, payee: accounts.payee.address });
    const ctx = await boot({}, { chain });
    try {
      for (const action of ["createEscrow", "dispute", "withdraw", "withdrawTo"]) {
        const res = await request(ctx.port, "POST", "/v1/claims", {
          live: true,
          signature: "0x" + "11".repeat(65),
          intent: {
            action,
            escrowId,
            sender: accounts.payer.address,
            nonce: "1",
            deadline: deadlineAt(120),
            chainId: 84532,
            verifyingContract: BOOKED_ESCROW,
          },
        });
        assert.equal(res.status, 400, action);
        assert.equal(res.json.error, "action_not_claim", action);
        assert.equal(res.json.txHash, null);
      }
      assert.equal(chain.calls.reads.length, 0);
      assert.equal(chain.calls.erc1271.length, 0);
      assert.equal(chain.calls.simulations.length, 0);
      assert.equal(ctx.sent.length, 0);
    } finally {
      await ctx.close();
    }
  });

  it("rejects a high-s signature and a bad v before recovery", async () => {
    const chain = trackingChain({ payer: accounts.payer.address, payee: accounts.payee.address });
    const ctx = await boot({ ERC1271_ENABLED: "1" }, { chain });
    try {
      const high = await releaseBody(accounts.payer, { nonce: "501" });
      high.signature = malleableHighS(high.signature);
      const highRes = await request(ctx.port, "POST", "/v1/claims", high);
      assert.equal(highRes.status, 400);
      assert.equal(highRes.json.error, "high_s");
      assert.equal(chain.calls.erc1271.length, 0);
      assert.equal(chain.calls.reads.length, 0);
      assert.equal(ctx.sent.length, 0);

      const badV = await releaseBody(accounts.payer, { nonce: "502" });
      badV.signature = `${badV.signature.slice(0, 130)}02`;
      const badRes = await request(ctx.port, "POST", "/v1/claims", badV);
      assert.equal(badRes.status, 400);
      assert.equal(badRes.json.error, "invalid_signature");
      assert.equal(chain.calls.erc1271.length, 0);
      assert.equal(ctx.sent.length, 0);
    } finally {
      await ctx.close();
    }
  });

  it("lets exactly one of two concurrent same-nonce requests through", async () => {
    let releaseGate = () => {};
    const gate = new Promise((resolve) => {
      releaseGate = resolve;
    });
    let started = 0;
    const chain = trackingChain({
      payer: accounts.payer.address,
      payee: accounts.payee.address,
      simulate: async () => {
        started += 1;
        if (started === 1) await gate;
        return { ok: true, gasUsed: 50_000n, revertData: null };
      },
    });
    const ctx = await boot({}, { chain });
    try {
      const body = await releaseBody(accounts.payer, { nonce: "601" });
      const first = request(ctx.port, "POST", "/v1/claims", body);
      const waitStarted = Date.now();
      while (started < 1) {
        if (Date.now() - waitStarted > 2000) throw new Error("first claim did not reach simulation");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const second = await request(ctx.port, "POST", "/v1/claims", body);
      assert.equal(second.status, 409);
      assert.equal(second.json.error, "nonce_in_flight");
      releaseGate();
      const firstRes = await first;
      assert.equal(firstRes.status, 200);
      assert.equal(firstRes.json.txHash, TX);
      assert.equal(ctx.sent.length, 1);
      assert.equal(chain.calls.simulations.length, 1);
    } finally {
      releaseGate();
      await ctx.close();
    }
  });

  it("returns 429 from the IP bucket before the body is parsed", async () => {
    const chain = trackingChain({ payer: accounts.payer.address, payee: accounts.payee.address });
    const ctx = await boot({ CLAIM_RATE_IP: "1" }, { chain });
    try {
      const first = await request(ctx.port, "POST", "/v1/claims", await releaseBody(accounts.payer, { nonce: "701" }));
      assert.equal(first.status, 200);
      const reads = chain.calls.reads.length;
      const second = await request(ctx.port, "POST", "/v1/claims", "not-json");
      assert.equal(second.status, 429);
      assert.equal(second.json.error, "rate_limited");
      assert.equal(chain.calls.reads.length, reads);
      assert.equal(chain.calls.erc1271.length, 0);
      assert.equal(ctx.sent.length, 1);
    } finally {
      await ctx.close();
    }
  });

  it("counts only the rightmost X-Forwarded-For hop", async () => {
    const chain = trackingChain({ payer: accounts.payer.address, payee: accounts.payee.address });
    const ctx = await boot({ CLAIM_RATE_IP: "1" }, { chain });
    try {
      const first = await request(
        ctx.port,
        "POST",
        "/v1/claims",
        await releaseBody(accounts.payer, { nonce: "801" }),
        { "x-forwarded-for": "1.1.1.1, 203.0.113.9" },
      );
      assert.equal(first.status, 200);
      const spoofed = await request(
        ctx.port,
        "POST",
        "/v1/claims",
        await releaseBody(accounts.payer, { nonce: "802" }),
        { "x-forwarded-for": "203.0.113.9" },
      );
      assert.equal(spoofed.status, 429);
      assert.equal(spoofed.json.error, "rate_limited");
      const other = await request(
        ctx.port,
        "POST",
        "/v1/claims",
        await releaseBody(accounts.payer, { nonce: "803" }),
        { "x-forwarded-for": "1.1.1.1, 203.0.113.10" },
      );
      assert.equal(other.status, 200);
      assert.equal(ctx.sent.length, 2);
    } finally {
      await ctx.close();
    }
  });

  it("rejects a posted deadline or nonce that differs from the signed intent", async () => {
    const chain = trackingChain({ payer: accounts.payer.address, payee: accounts.payee.address });
    const ctx = await boot({}, { chain });
    try {
      const honest = await releaseBody(accounts.payer, { nonce: "901", deadline: deadlineAt(120) });
      const ok = await request(ctx.port, "POST", "/v1/claims", honest);
      assert.equal(ok.status, 200);
      assert.equal(ok.json.txHash, TX);
      const readsAfterOk = chain.calls.reads.length;
      const simulationsAfterOk = chain.calls.simulations.length;

      const shiftedDeadline = await releaseBody(accounts.payer, { nonce: "902", deadline: deadlineAt(120) });
      const bumpedDeadline = String(BigInt(shiftedDeadline.intent.deadline) + 1n);
      shiftedDeadline.intent.deadline = bumpedDeadline;
      const deadlineRes = await request(ctx.port, "POST", "/v1/claims", shiftedDeadline);
      assert.equal(deadlineRes.status, 401);
      assert.equal(deadlineRes.json.error, "invalid_signature");

      const shiftedNonce = await releaseBody(accounts.payer, { nonce: "903", deadline: deadlineAt(120) });
      shiftedNonce.intent.nonce = String(BigInt(shiftedNonce.intent.nonce) + 1n);
      const nonceRes = await request(ctx.port, "POST", "/v1/claims", shiftedNonce);
      assert.equal(nonceRes.status, 401);
      assert.equal(nonceRes.json.error, "invalid_signature");

      assert.equal(chain.calls.reads.length, readsAfterOk);
      assert.equal(chain.calls.simulations.length, simulationsAfterOk);
      assert.equal(ctx.sent.length, 1);
    } finally {
      await ctx.close();
    }
  });

  it("uses the booked escrow as the verifying contract", () => {
    assert.equal(BOOKED_ESCROW.toLowerCase(), "0x3d660502d75f1e97b08c110255921b437a3c4c42");
  });
});

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

function malleableHighS(signature) {
  const hex = String(signature).slice(2).toLowerCase();
  const r = hex.slice(0, 64);
  const s = BigInt(`0x${hex.slice(64, 128)}`);
  const v = Number.parseInt(hex.slice(128, 130), 16);
  const flippedS = (SECP256K1_N - s).toString(16).padStart(64, "0");
  const flippedV = v === 27 ? 28 : v === 28 ? 27 : v === 0 ? 1 : 0;
  return `0x${r}${flippedS}${flippedV.toString(16).padStart(2, "0")}`;
}
