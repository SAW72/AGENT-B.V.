import { describe, expect, it } from "vitest";
import { ESCROW, ESCROW_START_BLOCK, PANEL } from "../../src/constants.mjs";
import {
  addressInBloom,
  bloomForAddresses,
  bloomNeedsReceipts,
  reconcileWindow,
  type WindowBlock,
} from "../src/logWindow";

const OTHER = "0x1111111111111111111111111111111111111111";
const BLOCK = ESCROW_START_BLOCK;
const HASH = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TX = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function row(extra: Record<string, unknown> = {}) {
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

function blocks(extra: Partial<WindowBlock> = {}) {
  return new Map<number, WindowBlock>([
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
    expect(addressInBloom(empty, ESCROW)).toBe(false);
    expect(bloomNeedsReceipts(empty, [ESCROW, PANEL])).toBe(false);
    const hit = bloomForAddresses([ESCROW]);
    expect(addressInBloom(hit, ESCROW)).toBe(true);
    expect(addressInBloom(hit, OTHER)).toBe(false);
    expect(bloomNeedsReceipts(hit, [PANEL, ESCROW])).toBe(true);
    expect(bloomNeedsReceipts("0x", [ESCROW])).toBe(true);
  });

  it("rejects a non-array scan", () => {
    expect(reconcileWindow({
      fromBlock: BLOCK,
      toBlock: BLOCK,
      logs: null,
      blocks: blocks(),
      addresses: [ESCROW, PANEL],
    })).toEqual({ ok: false, reason: "unverifiable_log" });
  });

  it("holds when the scan has fewer logs than the receipts", () => {
    const header = blocks();
    const receipt = header.get(BLOCK)?.receipts?.[0] as { logs: unknown[] };
    receipt.logs.push(row({ logIndex: 2 }));
    expect(reconcileWindow({
      fromBlock: BLOCK,
      toBlock: BLOCK,
      logs: [row()],
      blocks: header,
      addresses: [ESCROW, PANEL],
    })).toEqual({ ok: false, reason: "logs_incomplete" });
  });

  it("accepts a bloom-negative block with no scanned logs and no receipts", () => {
    expect(reconcileWindow({
      fromBlock: BLOCK,
      toBlock: BLOCK,
      logs: [],
      blocks: blocks({
        logsBloom: `0x${"00".repeat(256)}`,
        transactions: [],
        receipts: null,
      }),
      addresses: [ESCROW, PANEL],
    })).toEqual({ ok: true });
  });

  it("accepts a bloom-positive block whose receipts have no watched logs", () => {
    expect(reconcileWindow({
      fromBlock: BLOCK,
      toBlock: BLOCK,
      logs: [],
      blocks: blocks({
        receipts: [{
          transactionHash: TX,
          blockHash: HASH,
          logs: [{ address: OTHER, topics: ["0x1"], data: "0x", blockHash: HASH, logIndex: 0 }],
        }],
      }),
      addresses: [ESCROW, PANEL],
    })).toEqual({ ok: true });
  });

  it("holds a bloom-positive block when a receipt is missing", () => {
    expect(reconcileWindow({
      fromBlock: BLOCK,
      toBlock: BLOCK,
      logs: [],
      blocks: blocks({ receipts: [] }),
      addresses: [ESCROW, PANEL],
    })).toEqual({ ok: false, reason: "logs_unverified" });
  });

  it("holds when the scanned block hash disagrees with the header", () => {
    expect(reconcileWindow({
      fromBlock: BLOCK,
      toBlock: BLOCK,
      logs: [row({ blockHash: `0x${"11".repeat(32)}` })],
      blocks: blocks(),
      addresses: [ESCROW, PANEL],
    })).toEqual({ ok: false, reason: "logs_unverified" });
  });

  it("accepts a scan that matches the receipt logs", () => {
    expect(reconcileWindow({
      fromBlock: BLOCK,
      toBlock: BLOCK,
      logs: [row()],
      blocks: blocks(),
      addresses: [ESCROW, PANEL],
    })).toEqual({ ok: true });
  });

  it("does not hold a window only because a removed twin was scanned", () => {
    expect(reconcileWindow({
      fromBlock: BLOCK,
      toBlock: BLOCK,
      logs: [row(), row({ removed: true })],
      blocks: blocks(),
      addresses: [ESCROW, PANEL],
    })).toEqual({ ok: true });
  });
});
