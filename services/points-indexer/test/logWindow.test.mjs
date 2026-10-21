import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ESCROW_START_BLOCK } from "../src/constants.mjs";
import { DEFAULT_ESCROW_ADDRESS, start } from "../src/main.mjs";
import {
  addressInBloom,
  bloomForAddresses,
  bloomNeedsReceipts,
  reconcileWindow,
} from "../src/logWindow.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ESCROW = DEFAULT_ESCROW_ADDRESS;
const PANEL = "0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb";
const OTHER = "0x1111111111111111111111111111111111111111";
const BLOCK = ESCROW_START_BLOCK;
const HASH = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TX = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function row(extra = {}) {
  return {
    address: ESCROW,
    topics: ["0xcc"],
    data: "0x",
    blockHash: HASH,
    blockNumber: BLOCK,
    transactionHash: TX,
    logIndex: 1,
    removed: false,
    ...extra,
  };
}

function blocks(extra = {}) {
  return new Map([
    [BLOCK, {
      hash: HASH,
      logsBloom: bloomForAddresses([ESCROW]),
      transactions: [TX],
      receipts: [{
        transactionHash: TX,
        blockHash: HASH,
        logs: [row()],
      }],
      ...extra,
    }],
  ]);
}

describe("log window reconciliation", () => {
  it("treats an empty bloom as proof the address is absent", () => {
    const empty = `0x${"00".repeat(256)}`;
    assert.equal(addressInBloom(empty, ESCROW), false);
    assert.equal(bloomNeedsReceipts(empty, [ESCROW, PANEL]), false);
    const hit = bloomForAddresses([ESCROW]);
    assert.equal(addressInBloom(hit, ESCROW), true);
    assert.equal(addressInBloom(hit, OTHER), false);
    assert.equal(bloomNeedsReceipts(hit, [PANEL, ESCROW]), true);
    assert.equal(bloomNeedsReceipts("0x", [ESCROW]), true);
  });

  it("rejects a non-array scan", () => {
    const result = reconcileWindow({
      fromBlock: BLOCK,
      toBlock: BLOCK,
      logs: null,
      blocks: blocks(),
      addresses: [ESCROW, PANEL],
    });
    assert.deepEqual(result, { ok: false, reason: "unverifiable_log" });
  });

  it("holds when the scan has fewer logs than the receipts", () => {
    const full = row({ logIndex: 2, transactionHash: TX });
    const header = blocks();
    header.get(BLOCK).receipts[0].logs.push(full);
    const result = reconcileWindow({
      fromBlock: BLOCK,
      toBlock: BLOCK,
      logs: [row()],
      blocks: header,
      addresses: [ESCROW, PANEL],
    });
    assert.deepEqual(result, { ok: false, reason: "logs_incomplete" });
  });

  it("accepts a bloom-negative block with no scanned logs and no receipts", () => {
    const header = blocks({
      logsBloom: `0x${"00".repeat(256)}`,
      transactions: [],
      receipts: null,
    });
    const result = reconcileWindow({
      fromBlock: BLOCK,
      toBlock: BLOCK,
      logs: [],
      blocks: header,
      addresses: [ESCROW, PANEL],
    });
    assert.deepEqual(result, { ok: true });
  });

  it("holds a bloom-positive block when a receipt is missing", () => {
    const header = blocks({ receipts: [] });
    const result = reconcileWindow({
      fromBlock: BLOCK,
      toBlock: BLOCK,
      logs: [],
      blocks: header,
      addresses: [ESCROW, PANEL],
    });
    assert.deepEqual(result, { ok: false, reason: "logs_unverified" });
  });

  it("holds when the scanned block hash disagrees with the header", () => {
    const result = reconcileWindow({
      fromBlock: BLOCK,
      toBlock: BLOCK,
      logs: [row({ blockHash: `0x${"11".repeat(32)}` })],
      blocks: blocks(),
      addresses: [ESCROW, PANEL],
    });
    assert.deepEqual(result, { ok: false, reason: "logs_unverified" });
  });

  it("accepts a scan that matches the receipt logs", () => {
    const result = reconcileWindow({
      fromBlock: BLOCK,
      toBlock: BLOCK,
      logs: [row()],
      blocks: blocks(),
      addresses: [ESCROW, PANEL],
    });
    assert.deepEqual(result, { ok: true });
  });
});

function dbDir() {
  return mkdtempSync(join(tmpdir(), "abv-log-window-"));
}

function withCode(rpc) {
  return {
    async chainId() {
      return 84532;
    },
    async getCode() {
      return "0x6001";
    },
    ...rpc,
  };
}

describe("scan holds an incomplete log window", () => {
  it("does not advance the cursor on a non-array log result", async () => {
    const dir = dbDir();
    const running = await start({
      once: true,
      env: {
        CHAIN_ID: "84532",
        POINTS_DB_PATH: join(dir, "ledger.sqlite"),
        POINTS_LOG_RANGE: "1",
      },
      rpc: withCode({
        async finalizedBlockNumber() {
          return BLOCK;
        },
        async getLogs() {
          return { logs: [] };
        },
      }),
    });
    try {
      assert.equal(running.ingested.endedEarly, true);
      assert.equal(running.ingested.reason, "unverifiable_log");
      assert.equal(running.indexer.lastScannedBlock(), null);
    } finally {
      await running.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("holds the cursor when receipts contain logs the scan omitted", async () => {
    const dir = dbDir();
    const scanned = row();
    const omitted = row({ logIndex: 2 });
    const running = await start({
      once: true,
      env: {
        CHAIN_ID: "84532",
        POINTS_DB_PATH: join(dir, "ledger.sqlite"),
        POINTS_LOG_RANGE: "1",
      },
      rpc: withCode({
        async finalizedBlockNumber() {
          return BLOCK;
        },
        async getLogs() {
          return [scanned];
        },
        async getBlock() {
          return {
            hash: HASH,
            logsBloom: bloomForAddresses([ESCROW]),
            transactions: [TX],
          };
        },
        async getBlockReceipts() {
          return [{
            transactionHash: TX,
            blockHash: HASH,
            logs: [scanned, omitted],
          }];
        },
      }),
    });
    try {
      assert.equal(running.ingested.reason, "logs_incomplete");
      assert.equal(running.indexer.lastScannedBlock(), null);
      assert.equal(running.ingested.inserted, 0);
    } finally {
      await running.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("commits a window whose receipts match the scan", async () => {
    const dir = dbDir();
    const scanned = row({ blockTimestamp: 1_700_000_000 });
    const running = await start({
      once: true,
      env: {
        CHAIN_ID: "84532",
        POINTS_DB_PATH: join(dir, "ledger.sqlite"),
        POINTS_LOG_RANGE: "1",
      },
      rpc: withCode({
        async finalizedBlockNumber() {
          return BLOCK;
        },
        async getLogs() {
          return [scanned];
        },
        async getBlock() {
          return {
            hash: HASH,
            logsBloom: bloomForAddresses([ESCROW]),
            transactions: [TX],
          };
        },
        async getBlockReceipts() {
          return [{
            transactionHash: TX,
            blockHash: HASH,
            logs: [scanned],
          }];
        },
      }),
    });
    try {
      assert.equal(running.ingested.endedEarly, false);
      assert.equal(running.ingested.inserted, 1);
      assert.equal(running.indexer.lastScannedBlock(), BLOCK);
    } finally {
      await running.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("advances through a bloom-negative empty block without receipts", async () => {
    const dir = dbDir();
    let receipts = 0;
    const running = await start({
      once: true,
      env: {
        CHAIN_ID: "84532",
        POINTS_DB_PATH: join(dir, "ledger.sqlite"),
        POINTS_LOG_RANGE: "1",
      },
      rpc: withCode({
        async finalizedBlockNumber() {
          return BLOCK;
        },
        async getLogs() {
          return [];
        },
        async getBlock() {
          return {
            hash: HASH,
            logsBloom: `0x${"00".repeat(256)}`,
            transactions: [],
          };
        },
        async getBlockReceipts() {
          receipts += 1;
          throw new Error("receipts should not be read");
        },
      }),
    });
    try {
      assert.equal(running.ingested.endedEarly, false);
      assert.equal(running.indexer.lastScannedBlock(), BLOCK);
      assert.equal(receipts, 0);
    } finally {
      await running.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
