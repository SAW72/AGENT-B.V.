import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DISCLAIMER } from "../src/disclaimer.mjs";

const EXPECTED = "Testnet only. Not a token. Can't be transferred, sold, or redeemed. May be adjusted or cancelled, and does not convert to anything.";

function readRepo(path) {
  return readFileSync(new URL(`../../../../${path}`, import.meta.url), "utf8");
}

test("disclaimer bytes match the locked sentence everywhere it is copied", () => {
  assert.equal(DISCLAIMER, EXPECTED);
  assert.equal(Buffer.from(DISCLAIMER).byteLength, Buffer.from(EXPECTED).byteLength);
  for (const path of [
    "docs/POINTS-PROGRAM.md",
    "docs/POINTS-ANNOUNCEMENT-DRAFT.md",
    "docs/AGENT-BV-POINTS-SPEC.md",
    "config/reputation/sepolia.json",
  ]) {
    assert.equal(readRepo(path).includes(EXPECTED), true, path);
  }
  const sepolia = JSON.parse(readRepo("config/reputation/sepolia.json"));
  assert.equal(sepolia.display.disclaimer, EXPECTED);
  assert.equal(Object.hasOwn(sepolia.disclaimer_links, "legal_notice_url"), true);
  assert.equal(Object.hasOwn(sepolia.disclaimer_links, "bvt_securities_disclaimer"), false);
});
