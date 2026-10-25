import assert from "node:assert/strict";
import { access, chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createAbuseGuard } from "../abuseLimits.mjs";
import { claimIntentDomain, claimIntentTypes } from "../claimIntent.mjs";
import { createRpcEscrowChain } from "../escrowChain.mjs";
import { budgetGasPriceWei, eip1559MaxFeePerGas, prepareLiveClaim } from "../liveAuth.mjs";
import { createMemoryIntentNonceStore } from "../intentNonceStore.mjs";

const ESCROW = "0x3d660502D75f1e97b08c110255921b437A3C4C42";
const ESCROW_ID = `0x${"ab".repeat(32)}`;
const NOW_SECONDS = 1_700_000_000;
const NOW_MS = NOW_SECONDS * 1000;
const RELAYER = "0x9D1b3E1400D2632d435cB7C0fC131C4f42B31861";

const limits = {
  senderLimit: 5,
  ipLimit: 2,
  globalLimit: 60,
  windowMs: 60_000,
  escrowCap: 8,
  escrowWindowMs: 86_400_000,
  dailyGasBudgetWei: "1000",
};

describe("budget gas price", () => {
  it("uses the quoted max fee, and the multiplier only when the quote is missing", () => {
    const abuse = {
      gasPriceWei: "1000000000",
      gasPriceMultiplier: 5,
      maxFeePerGasWei: "5000000000",
    };
    assert.equal(eip1559MaxFeePerGas(1_000_000_000n, 100_000_000n), 1_300_000_000n);
    assert.equal(budgetGasPriceWei(abuse, 2_000_000_000n), 2_000_000_000n);
    assert.equal(budgetGasPriceWei(abuse, 9_000_000_000n), 5_000_000_000n);
    assert.equal(budgetGasPriceWei(abuse, null), 5_000_000_000n);
    assert.equal(budgetGasPriceWei({ ...abuse, gasPriceMultiplier: 1 }, null), 1_000_000_000n);
  });

  it("charges a live claim at the quoted fee, not at 1 gwei", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const seen = [];
    const abuse = {
      async check() {},
      async consume(input) {
        seen.push(input.gasWei);
      },
    };
    const config = {
      chainId: 84532,
      escrowAddress: ESCROW,
      erc1271Enabled: false,
      acceptLegacyDomainName: true,
      abuse: {
        gasPriceWei: "1000000000",
        gasPriceMultiplier: 5,
        maxFeePerGasWei: "5000000000",
        maxGas: 500_000,
      },
    };
    const chain = {
      async readEscrow() {
        return { exists: true, payer: account.address, payee: account.address };
      },
      async simulate() {
        return { ok: true, gasUsed: 50_000n, maxFeePerGasWei: 2_000_000_000n, revertData: null };
      },
    };
    await prepareLiveClaim({
      body: await signedBody(account, 1n),
      config,
      chain,
      intentNonces: createMemoryIntentNonceStore({ now: () => NOW_MS }),
      abuse,
      nowMs: NOW_MS,
      ip: "203.0.113.10",
    });
    assert.equal(seen[0], 50_000n * 2_000_000_000n);

    const unquoted = {
      async readEscrow() {
        return { exists: true, payer: account.address, payee: account.address };
      },
      async simulate() {
        return { ok: true, gasUsed: 50_000n, revertData: null };
      },
    };
    await prepareLiveClaim({
      body: await signedBody(account, 2n),
      config,
      chain: unquoted,
      intentNonces: createMemoryIntentNonceStore({ now: () => NOW_MS }),
      abuse,
      nowMs: NOW_MS,
      ip: "203.0.113.11",
    });
    assert.equal(seen[1], 50_000n * 5_000_000_000n);
  });

  it("reads the signer fee from the latest base fee and priority fee", async () => {
    const chain = createRpcEscrowChain({
      escrowAddress: ESCROW,
      from: RELAYER,
      request: async ({ method }) => {
        if (method === "eth_chainId") return "0x14a34";
        if (method === "eth_estimateGas") return "0xc350";
        if (method === "eth_getBlockByNumber") return { baseFeePerGas: "0x3b9aca00" };
        if (method === "eth_maxPriorityFeePerGas") return "0x05f5e100";
        throw new Error(`unexpected ${method}`);
      },
    });
    const quoted = await chain.simulate({ to: ESCROW, data: "0x", valueWei: "0" });
    assert.equal(quoted.ok, true);
    assert.equal(quoted.gasUsed, 50_000n);
    assert.equal(quoted.maxFeePerGasWei, 1_300_000_000n);

    const missing = createRpcEscrowChain({
      escrowAddress: ESCROW,
      from: RELAYER,
      request: async ({ method }) => {
        if (method === "eth_chainId") return "0x14a34";
        if (method === "eth_estimateGas") return "0xc350";
        if (method === "eth_getBlockByNumber") throw new Error("fee down");
        throw new Error(`unexpected ${method}`);
      },
    });
    const bare = await missing.simulate({ to: ESCROW, data: "0x", valueWei: "0" });
    assert.equal(bare.ok, true);
    assert.equal(bare.maxFeePerGasWei, undefined);
  });
});

describe("abuse state file", () => {
  it("reloads the daily gas spend and the ip bucket after a new process", async () => {
    const dir = await mkdtemp(join(tmpdir(), "abuse-state-"));
    const filePath = join(dir, "abuse-state.json");
    const first = createAbuseGuard(limits, { filePath, now: () => 1_000_000 });
    await first.consume({
      sender: "0xAbC",
      ip: "203.0.113.8",
      escrowId: "0x01",
      gasWei: 600n,
      atMs: 1_000_000,
    });
    await first.takeIp("203.0.113.8", 1_000_000);
    await first.takeIp("203.0.113.8", 1_000_100);

    const second = createAbuseGuard(limits, { filePath, now: () => 1_000_200 });
    await assert.rejects(
      second.check({
        sender: "0xdef",
        ip: "203.0.113.9",
        escrowId: "0x02",
        gasWei: 500n,
        atMs: 1_000_200,
      }),
      (err) => err.error === "gas_budget_exhausted",
    );
    await assert.rejects(second.takeIp("203.0.113.8", 1_000_200), (err) => err.error === "rate_limited");
  });

  it("drops a spent day on reload and refuses a corrupt file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "abuse-state-old-"));
    const filePath = join(dir, "abuse-state.json");
    const day = 24 * 60 * 60 * 1000;
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        events: [
          {
            atMs: 1_000,
            sender: "0xabc",
            ip: "203.0.113.1",
            escrowId: "0x01",
            gasWei: "1000",
          },
        ],
        buckets: [],
      }),
    );
    const guard = createAbuseGuard(limits, { filePath, now: () => 1_000 + day * 2 });
    await guard.check({
      sender: "0xdef",
      ip: "203.0.113.2",
      escrowId: "0x02",
      gasWei: 1000n,
      atMs: 1_000 + day * 2,
    });

    const broken = join(dir, "broken.json");
    await writeFile(broken, "{", "utf8");
    assert.throws(() => createAbuseGuard(limits, { filePath: broken }), (err) => err.error === "abuse_state_corrupt");
  });

  it("fails closed when the abuse state path cannot be written", async () => {
    const dir = await mkdtemp(join(tmpdir(), "abuse-state-blocked-"));
    const filePath = join(dir, "abuse-state.json");
    await chmod(dir, 0o500);
    try {
      const guard = createAbuseGuard(limits, { filePath, now: () => 1_000 });
      const input = {
        sender: "0xabc",
        ip: "203.0.113.1",
        escrowId: "0x01",
        gasWei: 1n,
        atMs: 1_000,
      };
      await assert.rejects(guard.consume(input));
      await assert.rejects(guard.takeIp("203.0.113.1", 1_000));
      await assert.rejects(access(filePath));
    } finally {
      await chmod(dir, 0o700);
    }
  });
});

async function signedBody(account, nonce) {
  const domain = claimIntentDomain(84532, ESCROW);
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
