import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ESCROW_START_BLOCK } from "../src/constants.mjs";
import {
  DEFAULT_DB_PATH,
  DEFAULT_ESCROW_ADDRESS,
  DEFAULT_POLL_MS,
  DEFAULT_RPC_URL,
  loadConfig,
  start,
} from "../src/main.mjs";
import { loadFixture } from "./support.mjs";

const CONFIG_FILES = ["../render.yaml", "../Dockerfile"].map((name) =>
  fileURLToPath(new URL(name, import.meta.url)),
);

describe("process entry", () => {
  it("loads Base Sepolia defaults when env is empty", () => {
    const config = loadConfig({});
    assert.equal(config.chainId, 84532);
    assert.equal(config.rpcUrl, DEFAULT_RPC_URL);
    assert.equal(config.rpcUrl, "https://sepolia.base.org");
    assert.equal(config.escrowAddress, DEFAULT_ESCROW_ADDRESS);
    assert.equal(config.escrowAddress, "0x3d660502D75f1e97b08c110255921b437A3C4C42");
    assert.equal(config.dbPath, DEFAULT_DB_PATH);
    assert.equal(config.pollMs, DEFAULT_POLL_MS);
  });

  it("overrides rpc, database path, and poll interval from env", () => {
    const config = loadConfig({
      CHAIN_ID: "84532",
      BASE_SEPOLIA_RPC_URL: "https://sepolia.base.org/example",
      ESCROW_ADDRESS: "0x3d660502D75f1e97b08c110255921b437A3C4C42",
      POINTS_DB_PATH: "/tmp/points-indexer/ledger.sqlite",
      POINTS_POLL_MS: "2500",
    });
    assert.equal(config.rpcUrl, "https://sepolia.base.org/example");
    assert.equal(config.dbPath, "/tmp/points-indexer/ledger.sqlite");
    assert.equal(config.pollMs, 2500);
    const fromUrl = loadConfig({ DATABASE_URL: "/var/tmp/ledger.sqlite" });
    assert.equal(fromUrl.dbPath, "/var/tmp/ledger.sqlite");
  });

  it("refuses a chain id other than 84532", () => {
    for (const chainId of ["1", "8453", "84531", "0", "abc"]) {
      assert.throws(() => loadConfig({ CHAIN_ID: chainId }), /CHAIN_ID must be 84532/);
    }
  });

  it("refuses a missing, zero, or malformed escrow address", () => {
    assert.throws(() => loadConfig({ ESCROW_ADDRESS: "" }), /ESCROW_ADDRESS is missing/);
    assert.throws(() => loadConfig({ ESCROW_ADDRESS: "   " }), /ESCROW_ADDRESS is missing/);
    assert.throws(
      () => loadConfig({ ESCROW_ADDRESS: "0x0000000000000000000000000000000000000000" }),
      /zero address/,
    );
    assert.throws(() => loadConfig({ ESCROW_ADDRESS: "0x1234" }), /malformed/);
    assert.throws(() => loadConfig({ ESCROW_ADDRESS: "not-an-address" }), /malformed/);
    assert.throws(
      () => loadConfig({ ESCROW_ADDRESS: "0x1111111111111111111111111111111111111111" }),
      /ESCROW_ADDRESS must be 0x3d660502D75f1e97b08c110255921b437A3C4C42/,
    );
  });

  it("refuses an RPC chain id other than 84532 before reading logs", async () => {
    let logsCalled = false;
    const dir = mkdtempSync(join(tmpdir(), "abv-entry-"));
    try {
      await assert.rejects(
        () => start({
          once: true,
          env: { CHAIN_ID: "84532", POINTS_DB_PATH: join(dir, "ledger.sqlite") },
          rpc: {
            async chainId() {
              return 8453;
            },
            async finalizedBlockNumber() {
              return 1;
            },
            async getLogs() {
              logsCalled = true;
              return [];
            },
          },
        }),
        /RPC chain id is 8453, expected 84532/,
      );
      assert.equal(logsCalled, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps signing material out of the reference config", () => {
    const text = CONFIG_FILES.map((file) => readFileSync(file, "utf8")).join("\n");
    assert.doesNotMatch(text, /0x[0-9a-fA-F]{64}/);
    assert.doesNotMatch(text, /PRIVATE_KEY\s*[:=]\s*\S+/);
    assert.doesNotMatch(text, /API_KEY\s*[:=]\s*\S+/);
    const yaml = readFileSync(CONFIG_FILES[0], "utf8");
    assert.match(yaml, /BASE_SEPOLIA_RPC_URL[\s\S]*?sync:\s*false/);
    assert.doesNotMatch(yaml, /BASE_SEPOLIA_RPC_URL[\s\S]{0,120}\bvalue\s*:/);
  });

  it("ingests fixture logs from an injected client and stops", async () => {
    const fixture = loadFixture();
    const dir = mkdtempSync(join(tmpdir(), "abv-entry-"));
    const dbPath = join(dir, "nested", "ledger.sqlite");
    let getLogsCalls = 0;
    const running = await start({
      once: true,
      env: {
        CHAIN_ID: "84532",
        POINTS_DB_PATH: dbPath,
        BASE_SEPOLIA_RPC_URL: "https://sepolia.base.org",
      },
      rpc: {
        async chainId() {
          return 84532;
        },
        async finalizedBlockNumber() {
          return fixture.captured_finalized_block;
        },
        async getLogs(args) {
          getLogsCalls += 1;
          assert.equal(args.fromBlock, ESCROW_START_BLOCK);
          assert.equal(args.toBlock, fixture.captured_finalized_block);
          assert.equal(args.address[0].toLowerCase(), "0x3d660502d75f1e97b08c110255921b437a3c4c42");
          return fixture.logs;
        },
      },
    });
    try {
      assert.equal(getLogsCalls, 1);
      assert.equal(running.ingested.inserted, fixture.logs.length);
      const stored = running.indexer.db.prepare("SELECT COUNT(*) AS n FROM raw_logs").get();
      assert.equal(stored.n, fixture.logs.length);
      const chain = running.indexer.db.prepare("SELECT chain_id FROM raw_logs LIMIT 1").get();
      assert.equal(chain.chain_id, 84532);
      await running.stop();
      await running.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
