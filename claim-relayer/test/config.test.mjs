import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAddressBook, parseStartBlock } from "../addressBook.mjs";
import { BOOKED_SEPOLIA_ESCROW, BOOKED_SEPOLIA_ESCROW_START_BLOCK, DEFAULT_RELAYER_ADDRESS, buildMetadata, healthPayload, liveSubmitStatus, loadConfig } from "../config.mjs";

const RETIRED_ESCROW = "0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c";
const SUPERSEDED_DENYLIST = "0xF0f260967D377E07Bdd7840862508ddB23C012b8";
const CURRENT_DENYLIST = "0xeE76876bECcFc1B58fC06fF4E654a517d784B224";
const LIVE_PANEL = "0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb";

const SECRET = "0x" + "ab".repeat(32);

describe("config gates", () => {
  it("defaults to Base Sepolia fixtures and the public hot wallet", () => {
    const config = loadConfig({ RELAYER_PRIVATE_KEY: SECRET });
    assert.equal(config.chainId, 84532);
    assert.equal(config.relayerAddress, DEFAULT_RELAYER_ADDRESS);
    assert.equal(config.escrowBooked, true);
    assert.equal(config.escrowSource, "address_book");
    assert.equal(config.escrowAddress, "0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d");
    assert.equal(config.escrowStartBlock, 47345163);
    assert.equal(config.escrowStartBlock, BOOKED_SEPOLIA_ESCROW_START_BLOCK);
    assert.equal(config.escrowStartBlockSource, "address_book");
    const health = healthPayload(config, false);
    assert.equal(health.escrowStartBlock, BOOKED_SEPOLIA_ESCROW_START_BLOCK);
    assert.equal(health.escrowStartBlockSource, "address_book");
    assert.equal(config.disputePanelAddress, "0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb");
    assert.equal(config.coreTimelock, "0x10CC9474b45625ADfd05C209f2518023484878D9");
    assert.equal(config.governanceTimelock, "0xa1abD23Ae5A3aaAfda29345Df64F9Aa45ac6ca33");
    assert.equal(config.bvtAddress, null);
    assert.equal(config.liveSubmit.allowed, false);
    assert.equal(config.claimApiSecret, undefined);
    assert.equal(config.erc1271Enabled, false);
    assert.equal(config.abuse.senderLimit, 5);
    assert.equal(config.abuse.ipLimit, 30);
    assert.equal(config.abuse.escrowCap, 8);
    assert.equal(config.abuse.dailyGasBudgetWei, "10000000000000000");
    assert.equal(
      config.corsOrigins,
      "https://agent-a-wallet-ux.pages.dev,http://localhost:5173,http://127.0.0.1:5173",
    );
    assert.deepEqual(config.liveSubmit.blockers, ["spencer_run_auth_required", "live_submit_off"]);
    assert.equal(JSON.stringify(config).includes(SECRET), false);
    assert.equal(Object.hasOwn(config, "RELAYER_PRIVATE_KEY"), false);
  });

  it("treats a zero escrow address as unbooked and a real one as booked", () => {
    const zero = loadConfig({ ESCROW_ADDRESS: "0x0000000000000000000000000000000000000000" });
    assert.equal(zero.escrowBooked, false);
    assert.equal(zero.escrowStartBlock, null);
    assert.equal(zero.escrowStartBlockSource, "unbooked");
    const booked = loadConfig({
      ESCROW_ADDRESS: "0x1111111111111111111111111111111111111111",
      LIVE_SUBMIT: "1",
      SPENCER_RUN_AUTH: "1",
    });
    assert.equal(booked.escrowBooked, true);
    assert.equal(booked.escrowSource, "env");
    assert.equal(booked.escrowStartBlock, null);
    assert.equal(booked.escrowStartBlockSource, "unset");
    assert.notEqual(booked.escrowStartBlock, BOOKED_SEPOLIA_ESCROW_START_BLOCK);
    assert.equal(booked.liveSubmit.allowed, false);
    assert.equal(booked.liveSubmit.requested, true);
    assert.equal(booked.liveSubmit.spencerAuth, true);
    assert.deepEqual(booked.liveSubmit.blockers, ["escrow_not_booked_sepolia"]);
    const health = healthPayload(booked, false);
    assert.equal(health.escrowStartBlock, null);
    assert.equal(health.escrowStartBlockSource, "unset");
  });

  it("does not load CLAIM_API_SECRET onto config or health", () => {
    const config = loadConfig({
      LIVE_SUBMIT: "1",
      SPENCER_RUN_AUTH: "1",
      CLAIM_API_SECRET: "claim-health-secret",
      ADMIN_SECRET: "admin-health-secret",
    });
    assert.equal(Object.hasOwn(config, "claimApiSecret"), false);
    assert.equal(config.adminSecret, "admin-health-secret");
    const health = JSON.stringify(healthPayload(config, false));
    assert.equal(health.includes("claim-health-secret"), false);
    assert.equal(health.includes("admin-health-secret"), false);
    assert.equal(health.includes("CLAIM_API_SECRET"), false);
  });

  it("allows live submit only for the booked Base Sepolia escrow", async () => {
    const unlocked = loadConfig({ LIVE_SUBMIT: "1", SPENCER_RUN_AUTH: "1" });
    assert.equal(unlocked.chainId, 84532);
    assert.equal(unlocked.escrowAddress, BOOKED_SEPOLIA_ESCROW);
    assert.equal(unlocked.liveSubmit.allowed, true);
    assert.deepEqual(unlocked.liveSubmit.blockers, []);
    assert.equal(JSON.stringify(unlocked).includes(SECRET), false);
    const book = JSON.parse(await readFile(new URL("../../deployments/base-sepolia.json", import.meta.url), "utf8"));
    assert.equal(book.chainId, 84532);
    assert.equal(book.BotAttestationEscrow.address, BOOKED_SEPOLIA_ESCROW);
    assert.equal(book.BotAttestationEscrow.startBlock, BOOKED_SEPOLIA_ESCROW_START_BLOCK);
    assert.equal(book.retired.BotAttestationEscrow.reason, "ESC-M-1 redeploy, retired 2026-09-26");
    assert.equal(book.claimRelayerWallet, DEFAULT_RELAYER_ADDRESS);

    const explicit = liveSubmitStatus(
      { LIVE_SUBMIT: "1", SPENCER_RUN_AUTH: "1" },
      { escrowBooked: true, escrowAddress: BOOKED_SEPOLIA_ESCROW, chainId: 84532 },
    );
    assert.equal(explicit.allowed, true);
    assert.equal(explicit.error, null);
  });

  it("refuses a mainnet address book", async () => {
    const dir = await mkdtemp(join(tmpdir(), "book-"));
    const filePath = join(dir, "book.json");
    await writeFile(filePath, JSON.stringify({ chainId: 8453, network: "base", BotAttestationEscrow: { address: null } }));
    assert.equal(loadConfigThrows({ ADDRESS_BOOK_PATH: filePath }), "mainnet_refused");
  });

  it("refuses mainnet and every other chain", () => {
    assert.equal(loadConfigThrows({ CHAIN_ID: "1", LIVE_SUBMIT: "1", SPENCER_RUN_AUTH: "1" }), "mainnet_refused");
    assert.equal(loadConfigThrows({ CHAIN_ID: "8453", LIVE_SUBMIT: "1", SPENCER_RUN_AUTH: "1" }), "mainnet_refused");
    assert.equal(loadConfigThrows({ CHAIN_ID: "11155111" }), "wrong_chain");
    assert.equal(loadConfigThrows({ CHAIN_ID: "421614" }), "wrong_chain");
    const mainnet = liveSubmitStatus(
      { LIVE_SUBMIT: "1", SPENCER_RUN_AUTH: "1" },
      { escrowBooked: true, escrowAddress: BOOKED_SEPOLIA_ESCROW, chainId: 8453 },
    );
    assert.equal(mainnet.allowed, false);
    assert.ok(mainnet.blockers.includes("mainnet_refused"));
    const ethereum = liveSubmitStatus(
      { LIVE_SUBMIT: "1", SPENCER_RUN_AUTH: "1" },
      { escrowBooked: true, escrowAddress: BOOKED_SEPOLIA_ESCROW, chainId: 1 },
    );
    assert.equal(ethereum.allowed, false);
    assert.ok(ethereum.blockers.includes("mainnet_refused"));
  });

  it("refuses a key file env", () => {
    assert.equal(loadConfigThrows({ RELAYER_PRIVATE_KEY_FILE: "/tmp/key" }), "key_file_forbidden");
  });

  it("keeps live submit blocked when the booked address is missing", () => {
    const status = liveSubmitStatus({ LIVE_SUBMIT: "1", SPENCER_RUN_AUTH: "1" }, true);
    assert.equal(status.allowed, false);
    assert.equal(status.error, "live_submit_blocked");
    assert.ok(status.blockers.includes("escrow_not_booked_sepolia"));
  });

  it("sends only from broadcast.mjs and never adds a forge broadcast", async () => {
    const quiet = [
      "app.mjs",
      "server.mjs",
      "claims.mjs",
      "config.mjs",
      "retry.mjs",
      "escrowCalldata.mjs",
      "addressBook.mjs",
      "readonlyEscrow.mjs",
      "claimIntent.mjs",
      "liveAuth.mjs",
      "intentNonceStore.mjs",
      "abuseLimits.mjs",
      "escrowChain.mjs",
    ];
    for (const name of quiet) {
      const text = await readFile(new URL(`../${name}`, import.meta.url), "utf8");
      assert.equal(text.includes("eth_sendRawTransaction"), false, name);
      assert.equal(text.includes("forge script"), false, name);
      assert.equal(text.includes("--broadcast"), false, name);
      assert.equal(text.includes(SECRET), false, name);
    }
    const sender = await readFile(new URL("../broadcast.mjs", import.meta.url), "utf8");
    assert.equal(sender.includes("eth_sendRawTransaction"), true);
    assert.equal(sender.includes("forge script"), false);
    assert.equal(sender.includes("--broadcast"), false);
    assert.equal(sender.includes(SECRET), false);
    assert.equal(sender.includes('from "viem/chains"'), true);
    assert.equal(sender.includes("baseSepolia"), true);
    assert.equal(/\bmainnet\b/.test(sender), false);
  });
});

describe("retired and superseded addresses", () => {
  it("refuses the retired escrow from ESCROW_ADDRESS at config load", () => {
    const err = loadConfigError({ ESCROW_ADDRESS: RETIRED_ESCROW });
    assert.equal(err.error, "retired_or_superseded_address");
    assert.match(err.message, /retired\/superseded/);
    assert.match(err.message, new RegExp(RETIRED_ESCROW));
    assert.match(err.message, new RegExp(BOOKED_SEPOLIA_ESCROW));
    assert.equal(err.current, BOOKED_SEPOLIA_ESCROW);
  });

  it("refuses a mixed-case retired escrow", () => {
    const mixed = "0x141214f04b0E1d949b6e6bf32D019Ad7Ab5B284C";
    const err = loadConfigError({ ESCROW_ADDRESS: mixed });
    assert.equal(err.error, "retired_or_superseded_address");
    assert.match(err.message, /retired\/superseded/);
    assert.ok(err.message.includes(mixed));
    assert.match(err.message, new RegExp(BOOKED_SEPOLIA_ESCROW));
  });

  it("refuses a superseded denylist address used as the escrow", () => {
    const err = loadConfigError({ ESCROW_ADDRESS: SUPERSEDED_DENYLIST });
    assert.equal(err.error, "retired_or_superseded_address");
    assert.match(err.message, /retired\/superseded/);
    assert.match(err.message, new RegExp(SUPERSEDED_DENYLIST));
    assert.match(err.message, new RegExp(CURRENT_DENYLIST));
    assert.equal(err.current, CURRENT_DENYLIST);
  });

  it("accepts the current booked escrow, including a case-only env override", () => {
    const config = loadConfig({ ESCROW_ADDRESS: BOOKED_SEPOLIA_ESCROW.toLowerCase() });
    assert.equal(config.escrowBooked, true);
    assert.equal(config.escrowSource, "env");
    assert.equal(config.escrowAddress, BOOKED_SEPOLIA_ESCROW.toLowerCase());
    assert.equal(config.escrowStartBlock, BOOKED_SEPOLIA_ESCROW_START_BLOCK);
    assert.equal(config.escrowStartBlockSource, "address_book");
  });

  it("refuses a book whose live escrow slot is retired", async () => {
    const filePath = await writeBook({
      BotAttestationEscrow: { address: RETIRED_ESCROW, startBlock: 47299930 },
    });
    const err = loadConfigError({ ADDRESS_BOOK_PATH: filePath });
    assert.equal(err.error, "retired_or_superseded_address");
    assert.match(err.message, new RegExp(RETIRED_ESCROW));
    assert.match(err.message, new RegExp(BOOKED_SEPOLIA_ESCROW));
  });

  it("refuses a retired address recorded only in the book", async () => {
    const retired = "0x4444444444444444444444444444444444444444";
    const current = "0x5555555555555555555555555555555555555555";
    const filePath = await writeBook({
      BotAttestationEscrow: { address: retired, startBlock: 10 },
      retired: { BotAttestationEscrow: { address: retired, supersededBy: current } },
    });
    const err = loadConfigError({ ADDRESS_BOOK_PATH: filePath });
    assert.equal(err.error, "retired_or_superseded_address");
    assert.match(err.message, /retired\/superseded/);
    assert.match(err.message, new RegExp(retired));
    assert.match(err.message, new RegExp(current));
    assert.equal(err.current, current);
  });

  it("refuses a governanceTimelock on the forbidden list", async () => {
    const filePath = await writeBook({
      BotAttestationEscrow: { address: BOOKED_SEPOLIA_ESCROW, startBlock: BOOKED_SEPOLIA_ESCROW_START_BLOCK },
      governanceTimelock: RETIRED_ESCROW,
    });
    const err = loadConfigError({ ADDRESS_BOOK_PATH: filePath });
    assert.equal(err.error, "retired_or_superseded_address");
    assert.match(err.message, new RegExp(RETIRED_ESCROW));
    assert.match(err.message, new RegExp(BOOKED_SEPOLIA_ESCROW));

    const denylistBook = await writeBook({
      BotAttestationEscrow: { address: BOOKED_SEPOLIA_ESCROW, startBlock: BOOKED_SEPOLIA_ESCROW_START_BLOCK },
      governanceTimelock: SUPERSEDED_DENYLIST,
    });
    const denylistErr = loadConfigError({ ADDRESS_BOOK_PATH: denylistBook });
    assert.equal(denylistErr.error, "retired_or_superseded_address");
    assert.match(denylistErr.message, new RegExp(SUPERSEDED_DENYLIST));
    assert.match(denylistErr.message, new RegExp(CURRENT_DENYLIST));
  });

  it("keeps a governanceTimelock that is not forbidden", async () => {
    const next = "0x1111111111111111111111111111111111111111";
    const filePath = await writeBook({
      BotAttestationEscrow: { address: BOOKED_SEPOLIA_ESCROW, startBlock: BOOKED_SEPOLIA_ESCROW_START_BLOCK },
      governanceTimelock: next,
    });
    const loaded = loadAddressBook(filePath);
    assert.equal(loaded.governanceTimelock, next);
    const config = loadConfig({ ADDRESS_BOOK_PATH: filePath });
    assert.equal(config.governanceTimelock, next);
  });

  it("refuses a dispute panel that is the retired escrow", async () => {
    const filePath = await writeBook({
      BotAttestationEscrow: { address: BOOKED_SEPOLIA_ESCROW, startBlock: BOOKED_SEPOLIA_ESCROW_START_BLOCK },
      DisputePanel: { address: RETIRED_ESCROW },
    });
    const err = loadConfigError({
      ADDRESS_BOOK_PATH: filePath,
      ESCROW_ADDRESS: BOOKED_SEPOLIA_ESCROW,
    });
    assert.equal(err.error, "retired_or_superseded_address");
    assert.match(err.message, new RegExp(RETIRED_ESCROW));
    assert.match(err.message, new RegExp(BOOKED_SEPOLIA_ESCROW));
  });
});

describe("start block parsing", () => {
  it("treats null, empty, and non-integers as missing, not block 0", () => {
    assert.equal(parseStartBlock(null), null);
    assert.equal(parseStartBlock(undefined), null);
    assert.equal(parseStartBlock(""), null);
    assert.equal(parseStartBlock("  "), null);
    assert.equal(parseStartBlock(1.5), null);
    assert.equal(parseStartBlock(-1), null);
    assert.equal(parseStartBlock("-3"), null);
    assert.equal(parseStartBlock("nope"), null);
    assert.equal(parseStartBlock(true), null);
    assert.equal(parseStartBlock(0), 0);
    assert.equal(parseStartBlock("0"), 0);
    assert.equal(parseStartBlock(BOOKED_SEPOLIA_ESCROW_START_BLOCK), BOOKED_SEPOLIA_ESCROW_START_BLOCK);
    assert.equal(parseStartBlock(String(BOOKED_SEPOLIA_ESCROW_START_BLOCK)), BOOKED_SEPOLIA_ESCROW_START_BLOCK);
  });

  it("does not turn a JSON null book start block into 0", async () => {
    const other = "0x2222222222222222222222222222222222222222";
    const filePath = await writeBook({
      BotAttestationEscrow: { address: other, deployBlock: null, startBlock: null },
    });
    const loaded = loadAddressBook(filePath);
    assert.equal(loaded.escrowStartBlock, null);
    const config = loadConfig({ ADDRESS_BOOK_PATH: filePath });
    assert.equal(config.escrowAddress, other);
    assert.equal(config.escrowStartBlock, null);
    assert.equal(config.escrowStartBlockSource, "unset");
    assert.notEqual(config.escrowStartBlock, 0);
    assert.notEqual(config.escrowStartBlock, BOOKED_SEPOLIA_ESCROW_START_BLOCK);
  });

  it("falls back to the booked constant only for the booked escrow when the book block is null", async () => {
    const filePath = await writeBook({
      BotAttestationEscrow: {
        address: BOOKED_SEPOLIA_ESCROW,
        deployBlock: null,
        startBlock: null,
      },
    });
    const loaded = loadAddressBook(filePath);
    assert.equal(loaded.escrowStartBlock, null);
    const config = loadConfig({ ADDRESS_BOOK_PATH: filePath });
    assert.equal(config.escrowStartBlock, BOOKED_SEPOLIA_ESCROW_START_BLOCK);
    assert.equal(config.escrowStartBlockSource, "booked_constant");
    assert.notEqual(config.escrowStartBlock, 0);
  });

  it("uses ESCROW_START_BLOCK for a different escrow and rejects a bad one", () => {
    const override = "0x1111111111111111111111111111111111111111";
    const config = loadConfig({ ESCROW_ADDRESS: override, ESCROW_START_BLOCK: "12345" });
    assert.equal(config.escrowAddress, override);
    assert.equal(config.escrowStartBlock, 12345);
    assert.equal(config.escrowStartBlockSource, "env");
    assert.notEqual(config.escrowStartBlock, BOOKED_SEPOLIA_ESCROW_START_BLOCK);

    const missing = loadConfig({ ESCROW_ADDRESS: override, ESCROW_START_BLOCK: null });
    assert.equal(missing.escrowStartBlock, null);
    assert.equal(missing.escrowStartBlockSource, "unset");
    const empty = loadConfig({ ESCROW_ADDRESS: override, ESCROW_START_BLOCK: "" });
    assert.equal(empty.escrowStartBlock, null);
    assert.equal(empty.escrowStartBlockSource, "unset");

    assert.equal(loadConfigThrows({ ESCROW_ADDRESS: override, ESCROW_START_BLOCK: "-1" }), "invalid_escrow_start_block");
    assert.equal(loadConfigThrows({ ESCROW_ADDRESS: override, ESCROW_START_BLOCK: "1.5" }), "invalid_escrow_start_block");
    const bad = loadConfigError({ ESCROW_ADDRESS: override, ESCROW_START_BLOCK: "nope" });
    assert.equal(bad.error, "invalid_escrow_start_block");
    assert.match(bad.message, /non-negative integer/);
    assert.match(bad.message, /booked start block is not used/);
  });

  it("reads the health commit only from RENDER_GIT_COMMIT", () => {
    assert.deepEqual(buildMetadata({}), { commit: null, builtAt: null });
    assert.deepEqual(buildMetadata({ RENDER_GIT_COMMIT: "  " }), { commit: null, builtAt: null });
    assert.deepEqual(buildMetadata({ GIT_COMMIT: "abc", VERCEL_GIT_COMMIT_SHA: "def" }), {
      commit: null,
      builtAt: null,
    });
    assert.deepEqual(buildMetadata({ RENDER_GIT_COMMIT: " deff214 " }), {
      commit: "deff214",
      builtAt: null,
    });
    const config = loadConfig({ RENDER_GIT_COMMIT: "deff214" });
    assert.equal(healthPayload(config, false).build.commit, "deff214");
  });

});

function loadConfigThrows(env) {
  return loadConfigError(env).error;
}

function loadConfigError(env) {
  try {
    loadConfig(env);
  } catch (err) {
    return err;
  }
  assert.fail("expected loadConfig to throw");
}

async function writeBook(overrides) {
  const dir = await mkdtemp(join(tmpdir(), "book-"));
  const filePath = join(dir, "book.json");
  const body = {
    chainId: 84532,
    network: "base-sepolia",
    DisputePanel: { address: LIVE_PANEL },
    Denylist: { address: CURRENT_DENYLIST },
    Vault: { address: "0x1463D664fA467FBCDA4B05443434494f05e565bc" },
    ...overrides,
  };
  await writeFile(filePath, JSON.stringify(body));
  return filePath;
}
