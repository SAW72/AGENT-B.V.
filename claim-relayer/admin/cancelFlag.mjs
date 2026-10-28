/**
 * Local admin path for checklist #9.
 * Verifies an EIP-712 FlagAction signed by the enforcer owner, then updates
 * the one matching ADJ row. It does not broadcast, and it does not read or
 * write caps, gates, points_ledger, or the enforcer identity.
 *
 *   node claim-relayer/admin/cancelFlag.mjs \
 *     --wallet 0x... --flag O5_REPEAT --reason "false positive" \
 *     --status cancelled --timestamp 2026-10-21T20:00:00.000Z \
 *     --signature 0x...
 */

import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getAddress, isAddress, keccak256, recoverTypedDataAddress } from "viem";

export const ENFORCER_OWNER = "0x41a023Ce2bd5Aee1e1aDF183b448bFF8F3D1EDd1";

/** Base Sepolia escrow. Domain only. This file does not write that config. */
export const FLAG_DOMAIN = {
  name: "Agent-BV Enforcer",
  version: "1",
  chainId: 84532,
  verifyingContract: "0x3d660502D75f1e97b08c110255921b437A3C4C42",
};

export const FLAG_TYPES = {
  FlagAction: [
    { name: "wallet", type: "address" },
    { name: "flagType", type: "string" },
    { name: "reason", type: "string" },
    { name: "status", type: "string" },
    { name: "timestamp", type: "string" },
  ],
};

const STATUSES = new Set(["cancelled", "frozen"]);
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const DEFAULT_FILE = fileURLToPath(new URL("../../config/reputation/adjustments.json", import.meta.url));

export class FlagRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = "FlagRefusal";
  }
}

function refuse(message) {
  return new FlagRefusal(message);
}

function requireText(value, label) {
  if (typeof value !== "string" || value.trim() === "" || /[\u0000-\u001f]/.test(value)) {
    throw refuse(`${label} is invalid`);
  }
  return value;
}

function requireTimestamp(value) {
  if (typeof value !== "string" || !TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) {
    throw refuse("timestamp must be UTC ISO-8601");
  }
  return Date.parse(value);
}

export function signatureHash(signature) {
  return keccak256(signature);
}

export async function recoverFlagSigner({ wallet, flagType, reason, status, timestamp, signature }) {
  try {
    return await recoverTypedDataAddress({
      domain: FLAG_DOMAIN,
      types: FLAG_TYPES,
      primaryType: "FlagAction",
      message: {
        wallet: getAddress(wallet),
        flagType,
        reason,
        status,
        timestamp,
      },
      signature,
    });
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const allowed = new Set(["wallet", "flag", "reason", "status", "timestamp", "signature", "file"]);
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) throw refuse(`unexpected argument ${token}`);
    const key = token.slice(2);
    if (!allowed.has(key)) throw refuse(`unknown argument --${key}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw refuse(`missing value for --${key}`);
    if (Object.hasOwn(out, key)) throw refuse(`duplicate --${key}`);
    out[key] = value;
    i += 1;
  }
  for (const key of ["wallet", "flag", "reason", "status", "timestamp", "signature"]) {
    if (!Object.hasOwn(out, key)) throw refuse(`missing --${key}`);
  }
  return out;
}

function rowMatches(row, wallet, flagType) {
  if (!row || typeof row.wallet !== "string" || typeof row.flag_type !== "string") return false;
  if (!isAddress(row.wallet)) return false;
  return getAddress(row.wallet) === wallet && row.flag_type === flagType;
}

export function unifiedDiff(before, after, label) {
  if (before === after) return "";
  const dir = mkdtempSync(join(tmpdir(), "adj-diff-"));
  const oldPath = join(dir, "before.json");
  const newPath = join(dir, "after.json");
  try {
    writeFileSync(oldPath, before);
    writeFileSync(newPath, after);
    const result = spawnSync("diff", ["-u", oldPath, newPath], { encoding: "utf8" });
    if (result.status !== 0 && result.status !== 1) {
      throw refuse(result.stderr?.trim() || "diff failed");
    }
    const lines = result.stdout.split("\n");
    if (lines[0]?.startsWith("---")) lines[0] = `--- ${label}`;
    if (lines[1]?.startsWith("+++")) lines[1] = `+++ ${label}`;
    return `${lines.join("\n").replace(/\n$/, "")}\n`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeJson(file, text) {
  const tmp = join(dirname(file), `.adj-${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/**
 * Verify the enforcer signature and update the one ADJ row for this wallet and flag.
 * `owner` defaults to the checklist #9 owner. The command line cannot override it.
 */
export async function applyFlagAction({
  file = DEFAULT_FILE,
  wallet,
  flagType,
  reason,
  status,
  timestamp,
  signature,
  owner = ENFORCER_OWNER,
}) {
  const subject = isAddress(wallet) ? getAddress(wallet) : null;
  if (!subject) throw refuse("wallet is invalid");
  const flag = requireText(flagType, "flag");
  const why = requireText(reason, "reason");
  if (!STATUSES.has(status)) throw refuse("status must be cancelled or frozen");
  const signedAt = requireTimestamp(timestamp);
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) {
    throw refuse("signature does not match the enforcer owner");
  }
  const signerOwner = isAddress(owner) ? getAddress(owner) : null;
  if (!signerOwner) throw refuse("enforcer owner is invalid");
  const recovered = await recoverFlagSigner({
    wallet: subject,
    flagType: flag,
    reason: why,
    status,
    timestamp,
    signature,
  });
  if (!recovered || getAddress(recovered) !== signerOwner) {
    throw refuse("signature does not match the enforcer owner");
  }

  let before;
  let parsed;
  try {
    before = readFileSync(file, "utf8");
    parsed = JSON.parse(before);
  } catch {
    throw refuse("adjustments file is unreadable");
  }
  if (!parsed || !Array.isArray(parsed.adjustments)) throw refuse("adjustments file is invalid");
  const matches = parsed.adjustments.filter((row) => rowMatches(row, subject, flag));
  if (matches.length === 0) throw refuse("no matching ADJ row");
  if (matches.length > 1) throw refuse("more than one matching ADJ row");
  const row = matches[0];
  const hash = signatureHash(signature);
  if (typeof row.timestamp === "string" && row.timestamp !== "") {
    const previous = Date.parse(row.timestamp);
    if (!Number.isNaN(previous) && signedAt < previous) throw refuse("stale signature");
    if (!Number.isNaN(previous) && signedAt === previous) {
      if (row.signature_hash === hash && row.status === status && row.cancel_reason === why) {
        const text = `updated row:\n${JSON.stringify(row, null, 2)}\ndiff:\n`;
        return { row, diff: "", text, wrote: false };
      }
      throw refuse("stale signature");
    }
  }

  row.cancel_reason = why;
  row.status = status;
  row.timestamp = timestamp;
  row.signature_hash = hash;
  const after = `${JSON.stringify(parsed, null, 2)}\n`;
  const diff = unifiedDiff(before, after, "config/reputation/adjustments.json");
  writeJson(file, after);
  const text = `updated row:\n${JSON.stringify(row, null, 2)}\ndiff:\n${diff}`;
  return { row, diff, text, wrote: true };
}

export async function main(argv, options = {}) {
  const args = parseArgs(argv);
  const result = await applyFlagAction({
    file: args.file || DEFAULT_FILE,
    wallet: args.wallet,
    flagType: args.flag,
    reason: args.reason,
    status: args.status,
    timestamp: args.timestamp,
    signature: args.signature,
    owner: options.owner || ENFORCER_OWNER,
  });
  const print = options.print || ((line) => console.log(line));
  print(result.text);
  return result;
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  main(process.argv.slice(2))
    .then(() => {})
    .catch((error) => {
      const message = error instanceof FlagRefusal ? error.message : error?.message || "could not update the adjustment";
      console.error(`refused: ${message}`);
      process.exit(1);
    });
}
