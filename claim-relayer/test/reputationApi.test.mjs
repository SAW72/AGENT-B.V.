import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createClaimRelayer } from "../app.mjs";
import { createClaimLog } from "../claimLog.mjs";
import { loadConfig, reputationCorsFromEnv } from "../config.mjs";
import { allowAllEligibility, createDefaultHooks, recordingEnforcer } from "../reputation/hooks.mjs";
import { createRateLimiter } from "../reputation/rateLimit.mjs";
import { ARBITRATOR_LEDGER, USAGE_LEDGER } from "../reputation/reputationConfig.mjs";
import { HISTORY_FIELDS, createReputationRuntime, handleReputationRequest } from "../reputation/runtime.mjs";
import { createKillSwitch } from "../killSwitch.mjs";
import { createNonceStore } from "../nonceStore.mjs";
import { BLOCK0, addr, businessLog, bytes32, dayTs, walletUxSampleLogs } from "./reputationFixture.mjs";

const WALLET = addr(0x11);
const VOTER = addr(0x31);
const UNKNOWN = addr(0x99);
const BANNED = /\b(reward|earn|earnings|apy|yield|allocation)\b/i;
const MONEY_KEYS = /^(total|combined|sum|usd|eth|token|reward|earn|earnings)$/i;
const FIXTURE_DIR = new URL("../fixtures/reputation/", import.meta.url);

function sampleLogs() {
  return walletUxSampleLogs();
}

function exampleRuntime() {
  return createReputationRuntime({
    logs: sampleLogs(),
    safeBlock: BLOCK0 + 100,
    finalizedBlock: BLOCK0 + 100,
    hooks: createDefaultHooks(),
  });
}

async function boot(extra = {}, env = {}) {
  const dir = await mkdtemp(join(tmpdir(), "claim-relayer-rep-"));
  const config = loadConfig({
    CLAIM_LOG_PATH: join(dir, "claims.jsonl"),
    RELAYER_PRIVATE_KEY: `0x${"ab".repeat(32)}`,
    ...env,
  });
  const server = createClaimRelayer({
    config,
    killSwitch: createKillSwitch({ initial: false }),
    nonceStore: createNonceStore(),
    claimLog: createClaimLog({ filePath: join(dir, "claims.jsonl") }),
    broadcaster: null,
    ...extra,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    port: server.address().port,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

function request(port, method, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode, json: raw ? JSON.parse(raw) : null, raw, headers: res.headers });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function keysOf(value, acc = []) {
  if (!value || typeof value !== "object") return acc;
  if (Array.isArray(value)) {
    for (const child of value) keysOf(child, acc);
    return acc;
  }
  for (const [key, child] of Object.entries(value)) {
    acc.push(key);
    keysOf(child, acc);
  }
  return acc;
}

describe("reputation read API", () => {
  it("returns the wallet contract, zeros for an unknown address, and draft config", async () => {
    const reputation = createReputationRuntime({
      logs: sampleLogs(),
      safeBlock: BLOCK0 + 100,
      finalizedBlock: BLOCK0 + 100,
      hooks: { eligibility: allowAllEligibility(), enforcer: recordingEnforcer() },
    });
    const ctx = await boot({ reputation });
    try {
      const body = await request(ctx.port, "GET", `/v1/reputation/${WALLET}?chainId=84532`);
      assert.equal(body.status, 200);
      assert.equal(body.json.address, WALLET.toLowerCase());
      assert.equal(body.json.chainId, 84532);
      assert.equal(body.json.ledgers.usage.ledger, USAGE_LEDGER);
      assert.equal(body.json.ledgers.usage.final, 12);
      assert.equal(body.json.ledgers.usage.provisional, 0);
      assert.equal(body.json.ledgers.arbitrator.ledger, ARBITRATOR_LEDGER);
      assert.equal(body.json.ledgers.arbitrator.final, 0);
      assert.equal(body.json.ledgers.arbitrator.provisional, 0);
      assert.equal(body.json.eligibility.status, "eligible");
      assert.equal(body.json.eligibility.points_withheld, false);
      assert.equal(body.json.indexed_to_block, BLOCK0 + 100);
      assert.equal(body.json.indexed_to_block_timestamp, dayTs(0, 5));
      assert.equal(body.json.finalized_block, BLOCK0 + 100);
      assert.equal(body.json.disclaimer.links.master_disclaimer, null);
      assert.equal(body.json.disclaimer.links.as_is, null);
      assert.match(body.json.disclaimer.text, /Testnet only/);
      assert.equal(body.json.ok, undefined);
      assert.equal(keysOf(body.json).some((key) => MONEY_KEYS.test(key)), false);
      assert.equal(BANNED.test(body.raw), false);

      const omitted = await request(ctx.port, "GET", `/v1/reputation/${WALLET}`);
      assert.equal(omitted.status, 200);
      assert.equal(omitted.json.chainId, 84532);
      assert.equal(omitted.json.address, WALLET.toLowerCase());

      const voter = await request(ctx.port, "GET", `/v1/reputation/${VOTER}`);
      assert.equal(voter.json.ledgers.arbitrator.final, 3);
      assert.equal(voter.json.ledgers.usage.final, 0);
      assert.equal("total" in voter.json, false);
      assert.equal("total" in voter.json.ledgers, false);

      const unknown = await request(ctx.port, "GET", `/v1/reputation/${UNKNOWN}`);
      assert.equal(unknown.status, 200);
      assert.equal(unknown.json.ledgers.usage.final, 0);
      assert.equal(unknown.json.ledgers.usage.provisional, 0);
      assert.equal(unknown.json.ledgers.arbitrator.final, 0);
      assert.equal(unknown.json.ledgers.arbitrator.provisional, 0);
    } finally {
      await ctx.close();
    }
  });

  it("pages history with section 6 fields and serves config before address matching", async () => {
    const logs = [];
    for (let bot = 1; bot <= 30; bot += 1) {
      logs.push(
        businessLog({
          event: "OperatorSet",
          address: "0x1463D664fA467FBCDA4B05443434494f05e565bc",
          args: { botId: bytes32(bot), account: WALLET },
          blockNumber: BLOCK0 + bot,
          timestamp: dayTs(bot, 1),
        }),
      );
    }
    const reputation = createReputationRuntime({
      logs,
      safeBlock: BLOCK0 + 100,
      finalizedBlock: BLOCK0 + 100,
      hooks: { eligibility: allowAllEligibility(), enforcer: recordingEnforcer() },
    });
    const ctx = await boot({ reputation, reputationRateLimit: createRateLimiter({ max: 40 }) });
    try {
      const page = await request(ctx.port, "GET", `/v1/reputation/${WALLET.toLowerCase()}/history?chainId=84532&ledger=usage`);
      assert.equal(page.status, 200);
      assert.equal(page.json.ledger, "usage");
      assert.equal(page.json.items.length, 25);
      assert.equal(page.json.address, WALLET.toLowerCase());
      assert.deepEqual(Object.keys(page.json.items[0]), HISTORY_FIELDS);
      assert.equal(page.json.items[0].ledger, USAGE_LEDGER);
      assert.equal(page.json.items[0].chain_id, 84532);
      assert.equal(page.json.items[0].wallet, WALLET.toLowerCase());
      assert.ok(page.json.items[0].block_number > page.json.items[1].block_number);
      assert.equal(BANNED.test(page.raw), false);
      assert.equal(keysOf(page.json).some((key) => MONEY_KEYS.test(key)), false);
      const next = await request(
        ctx.port,
        "GET",
        `/v1/reputation/${WALLET}/history?ledger=usage&limit=25&cursor=${encodeURIComponent(page.json.next_cursor)}`,
      );
      assert.equal(next.status, 200);
      assert.equal(next.json.items.length, 5);
      assert.equal(next.json.next_cursor, null);
      const seen = new Set([...page.json.items, ...next.json.items].map((entry) => entry.entry_id));
      assert.equal(seen.size, 30);

      const empty = await request(ctx.port, "GET", `/v1/reputation/${UNKNOWN}/history?ledger=arbitrator`);
      assert.equal(empty.status, 200);
      assert.deepEqual(empty.json.items, []);
      assert.equal(empty.json.next_cursor, null);
      assert.equal(empty.json.ledger, "arbitrator");

      const config = await request(ctx.port, "GET", "/v1/reputation/config");
      assert.equal(config.status, 200);
      assert.equal(config.json.chainId, 84532);
      assert.equal(config.json.status, "locked");
      assert.equal(config.json.points_ledger_status, "pending verification");
      assert.equal(config.json.points_ledger, undefined);
      assert.equal(config.json.config_version, "sepolia-draft-1");
      assert.equal(config.json.rule_version, "design-v2.2");
      assert.equal(typeof config.json.product, "string");
      assert.equal(typeof config.json.product_title, "string");
      assert.ok(config.json.product_title.startsWith(config.json.product));
      assert.equal(config.json.thresholds.season_length_days.value, 90);
      assert.equal(config.json.thresholds.season_start_block.value, null);
      assert.equal(config.json.thresholds.season_start_timestamp.value, null);
      assert.equal(config.json.caps.usage_points_per_wallet_per_day.value, 20);
      assert.equal(config.json.caps.usage_points_per_wallet_per_day.status, "locked");
      assert.equal(config.json.caps.arbitrator_points_per_day.status, "locked");
      assert.equal(config.json.thresholds.min_amount_wei.value, "100000000000000");
      assert.equal(config.json.thresholds.min_amount_wei.status, "locked");
      assert.equal(config.json.thresholds.o2_min_create_to_release_seconds.value, 300);
      assert.equal(config.json.thresholds.o5_window_days.value, 7);
      assert.equal(keysOf(config.json).some((key) => MONEY_KEYS.test(key)), false);
      assert.equal(config.json.address, undefined);

      const bad = await request(ctx.port, "GET", "/v1/reputation/nope");
      assert.equal(bad.status, 400);
      assert.equal(bad.json.error, "invalid_address");
      assert.equal(bad.json.ledgers, undefined);
      const short = await request(ctx.port, "GET", `/v1/reputation/${WALLET.slice(0, 20)}`);
      assert.equal(short.status, 400);
      assert.equal(short.json.error, "invalid_address");
      const mainnet = await request(ctx.port, "GET", `/v1/reputation/${WALLET}?chainId=1`);
      assert.equal(mainnet.status, 400);
      assert.equal(mainnet.json.error, "mainnet_refused");
      assert.equal(mainnet.json.ledgers, undefined);
      const base = await request(ctx.port, "GET", `/v1/reputation/config?chainId=8453`);
      assert.equal(base.status, 400);
      assert.equal(base.json.error, "mainnet_refused");
      assert.equal(base.json.caps, undefined);
      const other = await request(ctx.port, "GET", `/v1/reputation/${WALLET}/history?chainId=11155111&ledger=usage`);
      assert.equal(other.status, 400);
      assert.equal(other.json.error, "wrong_chain");
      assert.equal(other.json.items, undefined);
      const emptyChain = await request(ctx.port, "GET", `/v1/reputation/${WALLET}?chainId=`);
      assert.equal(emptyChain.status, 400);
      assert.equal(emptyChain.json.error, "wrong_chain");
      const limit = await request(ctx.port, "GET", `/v1/reputation/${WALLET}/history?ledger=usage&limit=0`);
      assert.equal(limit.status, 400);
      assert.equal(limit.json.error, "invalid_limit");
      const over = await request(ctx.port, "GET", `/v1/reputation/${WALLET}/history?ledger=usage&limit=101`);
      assert.equal(over.status, 400);
      assert.equal(over.json.error, "invalid_limit");
      const cursor = await request(ctx.port, "GET", `/v1/reputation/${WALLET}/history?ledger=usage&cursor=not-a-cursor`);
      assert.equal(cursor.status, 400);
      assert.equal(cursor.json.error, "invalid_cursor");
      const ledger = await request(ctx.port, "GET", `/v1/reputation/${WALLET}/history?ledger=${USAGE_LEDGER}`);
      assert.equal(ledger.status, 400);
      assert.equal(ledger.json.error, "invalid_ledger");
      const missing = await request(ctx.port, "GET", `/v1/reputation/${WALLET}/history`);
      assert.equal(missing.status, 400);
      assert.equal(missing.json.error, "invalid_ledger");
      const post = await request(ctx.port, "POST", `/v1/reputation/${WALLET}`);
      assert.equal(post.status, 405);
      assert.equal(post.json.error, "method_not_allowed");
      const postConfig = await request(ctx.port, "POST", "/v1/reputation/config");
      assert.equal(postConfig.status, 405);
    } finally {
      await ctx.close();
    }
  });

  it("withholds points while eligibility is unverified", async () => {
    const reputation = exampleRuntime();
    const ctx = await boot({ reputation });
    try {
      const body = await request(ctx.port, "GET", `/v1/reputation/${WALLET}?chainId=84532`);
      assert.equal(body.status, 200);
      assert.equal(body.json.eligibility.status, "unverified");
      assert.equal(body.json.eligibility.points_withheld, true);
      assert.equal(body.json.ledgers.usage.final, 0);
      assert.equal(body.json.ledgers.arbitrator.final, 0);
      const history = await request(ctx.port, "GET", `/v1/reputation/${WALLET}/history?ledger=usage`);
      assert.equal(history.json.items.length > 0, true);
      assert.equal(history.json.items.every((item) => item.points === 0), true);
    } finally {
      await ctx.close();
    }
  });

  it("allows agent-bv by default and refuses the previous Pages origin", async () => {
    const ctx = await boot({});
    try {
      const pages = await request(ctx.port, "GET", `/v1/reputation/${UNKNOWN}`, {
        origin: "https://agent-bv.pages.dev",
      });
      assert.equal(pages.headers["access-control-allow-origin"], "https://agent-bv.pages.dev");
      assert.equal(pages.headers["access-control-allow-credentials"], undefined);
      assert.notEqual(pages.headers["access-control-allow-origin"], "*");

      const previous = await request(ctx.port, "GET", `/v1/reputation/${UNKNOWN}`, {
        origin: "https://agent-a-wallet-ux.pages.dev",
      });
      assert.equal(previous.headers["access-control-allow-origin"], undefined);

      const preview = await request(ctx.port, "OPTIONS", `/v1/reputation/${UNKNOWN}`, {
        origin: "https://abc.agent-bv.pages.dev",
        "access-control-request-method": "GET",
      });
      assert.equal(preview.status, 204);
      assert.equal(preview.headers["access-control-allow-origin"], undefined);
      assert.equal(preview.headers["access-control-allow-credentials"], undefined);
      assert.match(String(preview.headers["access-control-allow-methods"]), /^GET,OPTIONS$/);
      assert.equal(String(preview.headers["access-control-allow-headers"]).includes("x-claim-secret"), false);

      for (const origin of [
        "https://evil.example",
        "https://evil-agent-bv.pages.dev",
        "https://agent-bv.pages.dev.evil.com",
        "http://agent-bv.pages.dev",
        "https://abc.agent-bv.pages.dev",
        "https://feat-wallet.agent-a-wallet-ux.pages.dev",
        "https://agent-a-wallet-ux.pages.dev.evil.example",
        "https://nested.preview.agent-a-wallet-ux.pages.dev",
        "http://localhost:5173",
        "http://127.0.0.1:4173",
        "https://localhost:5173",
        "http://localhost.evil.com",
      ]) {
        const rejected = await request(ctx.port, "GET", "/v1/reputation/config", { origin });
        assert.equal(rejected.headers["access-control-allow-origin"], undefined, origin);
        assert.notEqual(rejected.headers["access-control-allow-origin"], "*");
      }

      const claim = await request(ctx.port, "OPTIONS", "/v1/claims", {
        origin: "https://agent-bv.pages.dev",
      });
      assert.equal(claim.headers["access-control-allow-origin"], "https://agent-bv.pages.dev");
      const claimPrevious = await request(ctx.port, "OPTIONS", "/v1/claims", {
        origin: "https://agent-a-wallet-ux.pages.dev",
      });
      assert.equal(claimPrevious.headers["access-control-allow-origin"], undefined);
      const claimPreview = await request(ctx.port, "OPTIONS", "/v1/claims", {
        origin: "https://abc.agent-bv.pages.dev",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,authorization",
      });
      assert.equal(claimPreview.status, 204);
      assert.equal(claimPreview.headers["access-control-allow-origin"], undefined);
      assert.match(String(claimPreview.headers["access-control-allow-headers"]), /authorization/);
      assert.equal(String(claimPreview.headers["access-control-allow-headers"]).includes("x-claim-secret"), false);
    } finally {
      await ctx.close();
    }
  });

  it("rejects wildcard reputation origins and keeps old env vars as exact additions", async () => {
    const warnings = [];
    const warn = (message) => warnings.push(message);
    const wildcard = reputationCorsFromEnv(
      { REPUTATION_CORS_ORIGINS: "*,*.pages.dev,https://*.pages.dev,HTTPS://Wallet.Example/" },
      { warn },
    );
    assert.deepEqual(wildcard.origins, ["https://wallet.example"]);
    assert.equal(wildcard.warnings.some((message) => message.includes("wildcard")), true);
    assert.equal(wildcard.warnings.some((message) => message.includes("trailing_slash")), false);

    const mixed = reputationCorsFromEnv(
      { REPUTATION_CORS_ORIGINS: "https://agent-bv.pages.dev, *, https://*.pages.dev" },
      { warn },
    );
    assert.deepEqual(mixed.origins, ["https://agent-bv.pages.dev"]);

    const previewHost = reputationCorsFromEnv({ REPUTATION_CORS_PREVIEW_HOST: "pages.dev" }, { warn });
    assert.deepEqual(previewHost.origins, ["https://agent-bv.pages.dev"]);
    assert.equal(previewHost.origins.includes("https://agent-a-wallet-ux.pages.dev"), false);
    assert.equal(previewHost.origins.includes("https://pages.dev"), false);
    assert.equal(previewHost.origins.includes("*"), false);

    const star = reputationCorsFromEnv({ REPUTATION_CORS_PAGES_ORIGIN: "*" }, { warn });
    assert.equal(star.origins.includes("*"), false);
    assert.equal(star.origins.includes("https://agent-a-wallet-ux.pages.dev"), false);
    assert.deepEqual(star.origins, ["https://agent-bv.pages.dev"]);

    const explicit = reputationCorsFromEnv(
      { REPUTATION_CORS_ORIGINS: "https://agent-a-wallet-ux.pages.dev" },
      { warn },
    );
    assert.deepEqual(explicit.origins, ["https://agent-a-wallet-ux.pages.dev"]);
    const explicitServer = await boot({}, { REPUTATION_CORS_ORIGINS: "https://agent-a-wallet-ux.pages.dev" });
    try {
      const allowed = await request(explicitServer.port, "GET", "/v1/reputation/config", {
        origin: "https://agent-a-wallet-ux.pages.dev",
      });
      assert.equal(allowed.headers["access-control-allow-origin"], "https://agent-a-wallet-ux.pages.dev");
    } finally {
      await explicitServer.close();
    }

    const added = reputationCorsFromEnv(
      {
        REPUTATION_CORS_ORIGINS: "https://agent-bv.pages.dev",
        REPUTATION_CORS_PAGES_ORIGIN: "https://wallet.example/",
        REPUTATION_CORS_PREVIEW_HOST: "wallet.example",
        REPUTATION_CORS_LOCAL_HOSTS: "localhost,127.0.0.1",
      },
      { warn },
    );
    assert.deepEqual(added.origins, ["https://agent-bv.pages.dev", "https://wallet.example"]);
    assert.equal(added.origins.includes("https://pr-1.wallet.example"), false);
    assert.equal(added.origins.includes("https://agent-a-wallet-ux.pages.dev"), false);

    const ctx = await boot(
      {},
      {
        CORS_ORIGINS: "http://localhost:5173",
        REPUTATION_CORS_ORIGINS: "https://abc.agent-bv.pages.dev",
        REPUTATION_CORS_PAGES_ORIGIN: "https://wallet.example",
        REPUTATION_CORS_PREVIEW_HOST: "*.pages.dev",
      },
    );
    try {
      const listed = await request(ctx.port, "GET", "/v1/reputation/config", {
        origin: "https://abc.agent-bv.pages.dev",
      });
      assert.equal(listed.headers["access-control-allow-origin"], "https://abc.agent-bv.pages.dev");
      const sibling = await request(ctx.port, "GET", "/v1/reputation/config", {
        origin: "https://other.agent-bv.pages.dev",
      });
      assert.equal(sibling.headers["access-control-allow-origin"], undefined);
      const apex = await request(ctx.port, "GET", "/v1/reputation/config", {
        origin: "https://agent-bv.pages.dev",
      });
      assert.equal(apex.headers["access-control-allow-origin"], undefined);
      const custom = await request(ctx.port, "GET", "/v1/reputation/config", {
        origin: "https://wallet.example",
      });
      assert.equal(custom.headers["access-control-allow-origin"], "https://wallet.example");
      const preview = await request(ctx.port, "GET", "/v1/reputation/config", {
        origin: "https://pr-1.wallet.example",
      });
      assert.equal(preview.headers["access-control-allow-origin"], undefined);
      const claim = await request(ctx.port, "OPTIONS", "/v1/claims", {
        origin: "https://abc.agent-bv.pages.dev",
      });
      assert.equal(claim.headers["access-control-allow-origin"], undefined);
      const localClaim = await request(ctx.port, "OPTIONS", "/v1/claims", {
        origin: "http://localhost:5173",
      });
      assert.equal(localClaim.headers["access-control-allow-origin"], "http://localhost:5173");
    } finally {
      await ctx.close();
    }

    const normalized = reputationCorsFromEnv(
      {
        REPUTATION_CORS_ORIGINS: [
          "HTTPS://Wallet.Example/",
          "https://agent-bv.pages.dev:443",
          "http://agent-bv.pages.dev",
          "https://user:pass@agent-bv.pages.dev",
          "https://agent-bv.pages.dev/path",
          "https://agent-bv.pages.dev?x=1",
          "https://agent-bv.pages.dev#h",
          "null",
          "*",
        ].join(","),
      },
      { warn },
    );
    assert.deepEqual(normalized.origins, ["https://wallet.example"]);
    for (const reason of ["port", "scheme", "userinfo", "path", "query", "hash", "null", "wildcard"]) {
      assert.equal(
        normalized.warnings.some((message) => message.includes(`(${reason})`)),
        true,
        reason,
      );
    }
    assert.doesNotThrow(() => reputationCorsFromEnv({ REPUTATION_CORS_ORIGINS: "*,null,http://localhost:5173" }, { warn }));
    const refusedAll = reputationCorsFromEnv({ REPUTATION_CORS_ORIGINS: "*,null,http://localhost:5173" }, { warn });
    assert.deepEqual(refusedAll.origins, []);
    assert.equal(refusedAll.warnings.length > 0, true);

    const closed = await boot({}, { REPUTATION_CORS_ORIGINS: "*" });
    try {
      const refused = await request(closed.port, "GET", "/v1/reputation/config", {
        origin: "https://agent-bv.pages.dev",
      });
      assert.equal(refused.headers["access-control-allow-origin"], undefined);
      const any = await request(closed.port, "GET", "/v1/reputation/config", {
        origin: "https://evil.example",
      });
      assert.equal(any.headers["access-control-allow-origin"], undefined);
    } finally {
      await closed.close();
    }
  });

  it("matches the committed example responses", async () => {
    const runtime = exampleRuntime();
    const wallet = WALLET.toLowerCase();
    const cases = [
      ["balance.example.json", `http://127.0.0.1/v1/reputation/${wallet}?chainId=84532`],
      ["history.example.json", `http://127.0.0.1/v1/reputation/${wallet}/history?chainId=84532&ledger=usage&limit=25`],
      ["config.example.json", "http://127.0.0.1/v1/reputation/config?chainId=84532"],
    ];
    for (const [file, href] of cases) {
      const example = JSON.parse(await readFile(new URL(file, FIXTURE_DIR), "utf8"));
      assert.equal(example.example, true);
      assert.match(example.label, /EXAMPLE DATA/);
      assert.equal(example.response_is_live_chain_data, false);
      const body = handleReputationRequest(runtime, new URL(href));
      assert.deepEqual(body, example.response);
      assert.equal(BANNED.test(JSON.stringify(example.response)), false);
    }
  });

  it("rate limits reads and leaves the default ledger at zero", async () => {
    const limited = await boot({ reputationRateLimit: createRateLimiter({ max: 2 }) });
    try {
      const first = await request(limited.port, "GET", `/v1/reputation/${WALLET}`);
      const second = await request(limited.port, "GET", `/v1/reputation/${WALLET}`);
      const third = await request(limited.port, "GET", `/v1/reputation/${WALLET}`);
      assert.equal(first.status, 200);
      assert.equal(first.json.ledgers.usage.final, 0);
      assert.equal(first.json.ledgers.arbitrator.provisional, 0);
      assert.equal(first.json.eligibility.status, "unverified");
      assert.equal(first.json.eligibility.points_withheld, true);
      assert.equal(first.json.indexed_to_block, null);
      assert.equal(first.json.finalized_block, null);
      assert.equal(second.status, 200);
      assert.equal(third.status, 429);
      assert.equal(third.json.error, "rate_limited");
      assert.equal(BANNED.test(first.raw), false);
    } finally {
      await limited.close();
    }
  });
});
