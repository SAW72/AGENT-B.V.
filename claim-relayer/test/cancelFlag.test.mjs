import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getAddress, keccak256 } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { validateAdjustments } from "../reputation/reputationConfig.mjs";
import {
  ENFORCER_OWNER,
  FLAG_DOMAIN,
  FLAG_TYPES,
  applyFlagAction,
  main,
} from "../admin/cancelFlag.mjs";

const SUBJECT = getAddress("0x00000000000000000000000000000000000000a1");
const TIMESTAMP = "2026-10-21T20:00:00.000Z";
const LATER = "2026-10-21T21:00:00.000Z";
const SCRIPT = fileURLToPath(new URL("../admin/cancelFlag.mjs", import.meta.url));

function fixture() {
  return {
    _status: "DRAFT. Version-controlled manual adjustments and cancels. Change this file by pull request. Replay applies it. There is no admin write endpoint.",
    adjustments: [
      {
        adjustment_id: "adj-flag-1",
        ledger: "agent-bv-sepolia-reputation",
        wallet: SUBJECT,
        flag_type: "O5_REPEAT",
        points: 0,
        effective_block: 47715415,
        block_timestamp: 1700000000,
        cancel_reason: "pending",
        cancelled_by: "enforcer",
        cancels_entry_id: null,
      },
      {
        adjustment_id: "adj-other",
        ledger: "agent-bv-sepolia-reputation",
        wallet: SUBJECT,
        flag_type: "BOT_BURNED",
        points: 0,
        effective_block: 47715415,
        block_timestamp: 1700000000,
        cancel_reason: "pending",
        cancelled_by: "enforcer",
        cancels_entry_id: null,
      },
    ],
  };
}

function writeFixture(body = fixture()) {
  const dir = mkdtempSync(join(tmpdir(), "adj-cli-"));
  const file = join(dir, "adjustments.json");
  const text = `${JSON.stringify(body, null, 2)}\n`;
  writeFileSync(file, text);
  return { dir, file, text };
}

async function sign(account, message, domain = FLAG_DOMAIN) {
  return account.signTypedData({
    domain,
    types: FLAG_TYPES,
    primaryType: "FlagAction",
    message,
  });
}

function message(overrides = {}) {
  return {
    wallet: SUBJECT,
    flagType: "O5_REPEAT",
    reason: "false positive",
    status: "cancelled",
    timestamp: TIMESTAMP,
    ...overrides,
  };
}

function args(file, signature, overrides = {}) {
  const fields = message(overrides);
  return [
    "--wallet", fields.wallet,
    "--flag", fields.flagType,
    "--reason", fields.reason,
    "--status", fields.status,
    "--timestamp", fields.timestamp,
    "--signature", signature,
    "--file", file,
  ];
}

test("updates the matching ADJ row and leaves every other field alone", async () => {
  const owner = privateKeyToAccount(generatePrivateKey());
  const signed = message();
  const signature = await sign(owner, signed);
  const { dir, file } = writeFixture();
  try {
    const lines = [];
    const result = await main(args(file, signature), {
      owner: owner.address,
      print: (line) => lines.push(line),
    });
    const saved = JSON.parse(readFileSync(file, "utf8"));
    const row = saved.adjustments[0];
    assert.equal(row.status, "cancelled");
    assert.equal(row.timestamp, TIMESTAMP);
    assert.equal(row.signature_hash, keccak256(signature));
    assert.equal(row.cancel_reason, "false positive");
    assert.equal(row.points, 0);
    assert.equal(row.cancelled_by, "enforcer");
    assert.equal(row.cancels_entry_id, null);
    assert.equal(row.flag_type, "O5_REPEAT");
    assert.equal(saved.adjustments[1].flag_type, "BOT_BURNED");
    assert.equal(Object.hasOwn(saved.adjustments[1], "status"), false);
    assert.equal(saved._status.includes("no admin write endpoint"), true);
    const loaded = validateAdjustments(saved.adjustments);
    assert.equal(loaded[0].points, 0);
    assert.equal(loaded[0].cancel_reason, "false positive");
    assert.equal(loaded[0].cancels_entry_id, null);
    assert.match(lines.join("\n"), /updated row:/);
    assert.match(result.diff, /\+ +"status": "cancelled"/);
    assert.equal(result.diff.includes("BOT_BURNED"), false);
    assert.equal(result.wrote, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses a signature that is not from the enforcer owner and does not write", async () => {
  const stranger = privateKeyToAccount(generatePrivateKey());
  const signature = await sign(stranger, message());
  const { dir, file, text } = writeFixture();
  try {
    await assert.rejects(
      () => applyFlagAction({
        file,
        wallet: SUBJECT,
        flagType: "O5_REPEAT",
        reason: "false positive",
        status: "cancelled",
        timestamp: TIMESTAMP,
        signature,
      }),
      (error) => error.message === "signature does not match the enforcer owner",
    );
    assert.equal(readFileSync(file, "utf8"), text);
    assert.notEqual(getAddress(stranger.address), ENFORCER_OWNER);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses a signature over a different domain", async () => {
  const owner = privateKeyToAccount(generatePrivateKey());
  const signature = await sign(owner, message(), { ...FLAG_DOMAIN, name: "Agent-BV Relayer" });
  const { dir, file, text } = writeFixture();
  try {
    await assert.rejects(
      () => applyFlagAction({
        file,
        wallet: SUBJECT,
        flagType: "O5_REPEAT",
        reason: "false positive",
        status: "cancelled",
        timestamp: TIMESTAMP,
        signature,
        owner: owner.address,
      }),
      (error) => error.message === "signature does not match the enforcer owner",
    );
    assert.equal(readFileSync(file, "utf8"), text);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses when no row matches or more than one row matches", async () => {
  const owner = privateKeyToAccount(generatePrivateKey());
  const signature = await sign(owner, message());
  const missing = writeFixture();
  const doubledBody = fixture();
  doubledBody.adjustments = [
    doubledBody.adjustments[0],
    { ...doubledBody.adjustments[0], adjustment_id: "adj-flag-2" },
  ];
  const doubled = writeFixture(doubledBody);
  const missingText = readFileSync(missing.file, "utf8");
  const doubledText = readFileSync(doubled.file, "utf8");
  const missingSignature = await sign(owner, message({ flagType: "DENYLIST_LISTED" }));
  try {
    await assert.rejects(
      () => applyFlagAction({
        file: missing.file,
        wallet: SUBJECT,
        flagType: "DENYLIST_LISTED",
        reason: "false positive",
        status: "cancelled",
        timestamp: TIMESTAMP,
        signature: missingSignature,
        owner: owner.address,
      }),
      (error) => error.message === "no matching ADJ row",
    );
    await assert.rejects(
      () => applyFlagAction({
        file: doubled.file,
        wallet: SUBJECT,
        flagType: "O5_REPEAT",
        reason: "false positive",
        status: "cancelled",
        timestamp: TIMESTAMP,
        signature,
        owner: owner.address,
      }),
      (error) => error.message === "more than one matching ADJ row",
    );
    assert.equal(readFileSync(missing.file, "utf8"), missingText);
    assert.equal(readFileSync(doubled.file, "utf8"), doubledText);
  } finally {
    rmSync(missing.dir, { recursive: true, force: true });
    rmSync(doubled.dir, { recursive: true, force: true });
  }
});

test("refuses a stale signature and accepts a later freeze", async () => {
  const owner = privateKeyToAccount(generatePrivateKey());
  const first = await sign(owner, message());
  const { dir, file } = writeFixture();
  try {
    await applyFlagAction({
      file,
      wallet: SUBJECT,
      flagType: "O5_REPEAT",
      reason: "false positive",
      status: "cancelled",
      timestamp: TIMESTAMP,
      signature: first,
      owner: owner.address,
    });
    const afterFirst = readFileSync(file, "utf8");
    const stale = await sign(owner, message({ timestamp: "2026-10-21T19:00:00.000Z" }));
    await assert.rejects(
      () => applyFlagAction({
        file,
        wallet: SUBJECT,
        flagType: "O5_REPEAT",
        reason: "false positive",
        status: "cancelled",
        timestamp: "2026-10-21T19:00:00.000Z",
        signature: stale,
        owner: owner.address,
      }),
      (error) => error.message === "stale signature",
    );
    assert.equal(readFileSync(file, "utf8"), afterFirst);
    const freeze = message({ status: "frozen", timestamp: LATER, reason: "sybil cluster misattribution" });
    await applyFlagAction({
      file,
      ...{
        wallet: freeze.wallet,
        flagType: freeze.flagType,
        reason: freeze.reason,
        status: freeze.status,
        timestamp: freeze.timestamp,
        signature: await sign(owner, freeze),
        owner: owner.address,
      },
    });
    const saved = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(saved.adjustments[0].status, "frozen");
    assert.equal(saved.adjustments[0].timestamp, LATER);
    assert.equal(saved.adjustments[0].cancel_reason, "sybil cluster misattribution");
    assert.equal(saved.adjustments[0].points, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the command line refuses another wallet and refuses an owner override", async () => {
  const stranger = privateKeyToAccount(generatePrivateKey());
  const signature = await sign(stranger, message());
  const { dir, file, text } = writeFixture();
  try {
    const refused = spawnSync(process.execPath, [SCRIPT, ...args(file, signature)], { encoding: "utf8" });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /refused: signature does not match the enforcer owner/);
    assert.equal(readFileSync(file, "utf8"), text);
    const override = spawnSync(process.execPath, [SCRIPT, "--owner", stranger.address, ...args(file, signature)], { encoding: "utf8" });
    assert.equal(override.status, 1);
    assert.match(override.stderr, /refused: unknown argument --owner/);
    assert.equal(readFileSync(file, "utf8"), text);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
