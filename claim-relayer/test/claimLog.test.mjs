import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createClaimLog, sanitizeLogRecord } from "../claimLog.mjs";
import { sha256Utf8 } from "../sha256.mjs";

describe("claim JSONL log", () => {
  it("drops secrets and nested objects", () => {
    const clean = sanitizeLogRecord({
      event: "quote",
      claimId: "claim-1",
      payer: "0xabc",
      RELAYER_PRIVATE_KEY: "0x" + "ab".repeat(32),
      secret: "nope",
      nested: { privateKey: "hidden" },
      note: "contains private_key material",
    });
    assert.deepEqual(clean, { event: "quote", claimId: "claim-1" });
    const wallet = "0x5555555555555555555555555555555555555555";
    const hashed = sanitizeLogRecord({ event: "quote", payer: wallet, payee: "not-a-wallet" });
    assert.equal(hashed.payer, sha256Utf8(wallet));
    assert.equal("payee" in hashed, false);
    assert.equal(JSON.stringify(hashed).includes(wallet), false);
  });

  it("appends one JSON object per line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claim-log-"));
    const filePath = join(dir, "claims.jsonl");
    const log = createClaimLog({ filePath, now: () => Date.parse("2026-09-25T00:00:00.000Z") });
    await log.append({
      event: "claim_fixture",
      claimId: "claim-9",
      mode: "fixture",
      txHash: null,
      reason: "live_submit_blocked",
      privateKey: "0x" + "11".repeat(32),
    });
    const text = await readFile(filePath, "utf8");
    assert.equal(text.includes("privateKey"), false);
    assert.equal(text.includes("11".repeat(32)), false);
    const row = JSON.parse(text.trim());
    assert.equal(row.event, "claim_fixture");
    assert.equal(row.claimId, "claim-9");
    assert.equal(row.ts, "2026-09-25T00:00:00.000Z");
  });
});
