import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** deployments/base-sepolia.json next to this package. */
export const DEFAULT_ADDRESS_BOOK = fileURLToPath(
  new URL("../deployments/base-sepolia.json", import.meta.url),
);

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const BASE_SEPOLIA_CHAIN_ID = 84532;

/**
 * Previous Denylist, Vault, and retired escrows. Same pins as wallet-ux SUPERSEDED.
 * Blocked even when a book omits `retired` / `superseded`.
 */
export const SUPERSEDED = {
  denylist: "0xF0f260967D377E07Bdd7840862508ddB23C012b8",
  vault: "0xa1a067D2F58Ae54d4bb5Ec06d893B29E23A45CB7",
  botAttestationEscrow: "0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c",
  botAttestationEscrowEscM1: "0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d",
};

/** Live replacements for the pinned superseded contracts. */
const LIVE_ESCROW = "0x3d660502D75f1e97b08c110255921b437A3C4C42";
const SUPERSEDED_CURRENT = {
  [SUPERSEDED.denylist.toLowerCase()]: "0xeE76876bECcFc1B58fC06fF4E654a517d784B224",
  [SUPERSEDED.vault.toLowerCase()]: "0x1463D664fA467FBCDA4B05443434494f05e565bc",
  [SUPERSEDED.botAttestationEscrow.toLowerCase()]: LIVE_ESCROW,
  [SUPERSEDED.botAttestationEscrowEscM1.toLowerCase()]: LIVE_ESCROW,
};

function bookError(error, extra = {}) {
  return Object.assign(new Error(error), { status: 500, error, ...extra });
}

function optionalAddress(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!ADDRESS_RE.test(trimmed) || trimmed.toLowerCase() === ZERO_ADDRESS) return null;
  return trimmed;
}

function isMissingStartBlock(raw) {
  if (raw === null || raw === undefined) return true;
  if (typeof raw === "string" && raw.trim() === "") return true;
  return false;
}

/**
 * Non-negative integer block, or null when the value is missing or not a whole block.
 * JSON null and "" are missing. Number(null) is 0, so null must not go through Number().
 * @param {unknown} raw
 * @returns {number | null}
 */
export function parseStartBlock(raw) {
  if (isMissingStartBlock(raw)) return null;
  if (typeof raw === "boolean") return null;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!/^(0|[1-9]\d*)$/.test(trimmed)) return null;
    const n = Number(trimmed);
    if (!Number.isSafeInteger(n)) return null;
    return n;
  }
  if (typeof raw === "number") {
    if (!Number.isSafeInteger(raw) || raw < 0) return null;
    return raw;
  }
  return null;
}

/** Deploy block used as the indexer/relayer start block. Missing or invalid is null, never 0-by-coercion. */
function optionalStartBlock(slot) {
  if (!slot || typeof slot !== "object") return null;
  const raw = !isMissingStartBlock(slot.deployBlock) ? slot.deployBlock : slot.startBlock;
  return parseStartBlock(raw);
}

function addAddress(set, value) {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (!ADDRESS_RE.test(trimmed) || trimmed.toLowerCase() === ZERO_ADDRESS) return;
  set.add(trimmed.toLowerCase());
}

function walkAddressFields(node, visit) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) walkAddressFields(item, visit);
    return;
  }
  visit(node);
  for (const value of Object.values(node)) {
    if (value && typeof value === "object") walkAddressFields(value, visit);
  }
}

/**
 * `governanceTimelock` uses the same forbidden set as wallet-ux: the superseded pins plus
 * addresses recorded under `retired` and `superseded`. A hit is refused. Null stays null.
 * @param {unknown} value
 * @param {Set<string>} forbidden
 * @param {Map<string, string>} replacements
 */
function screenedGovernanceTimelock(value, forbidden, replacements) {
  const governanceTimelock = optionalAddress(value);
  if (!governanceTimelock) return null;
  rejectRetiredAddress(governanceTimelock, { forbidden, replacements });
  return governanceTimelock;
}

/** Lowercased addresses under retired.* and superseded.*, plus the SUPERSEDED pins. */
export function forbiddenAddresses(raw) {
  const blocked = new Set(Object.values(SUPERSEDED).map((address) => address.toLowerCase()));
  if (!raw || typeof raw !== "object") return blocked;
  for (const section of [raw.retired, raw.superseded]) {
    walkAddressFields(section, (node) => addAddress(blocked, node.address));
  }
  return blocked;
}

/** Lowercased retired/superseded address → current booked address (book supersededBy, else the pin). */
export function replacementAddresses(raw) {
  const map = new Map(Object.entries(SUPERSEDED_CURRENT));
  if (!raw || typeof raw !== "object") return map;
  for (const section of [raw.retired, raw.superseded]) {
    walkAddressFields(section, (node) => {
      if (typeof node.address !== "string") return;
      const from = node.address.trim();
      const current = typeof node.supersededBy === "string" ? node.supersededBy.trim() : "";
      if (!ADDRESS_RE.test(from) || !ADDRESS_RE.test(current) || current.toLowerCase() === ZERO_ADDRESS) return;
      map.set(from.toLowerCase(), current);
    });
  }
  return map;
}

/**
 * Follow supersededBy when it names another retired address.
 * The historical successor of 0x141214… is 0x1069…, which is itself retired.
 * @param {string} key lowercased retired address
 * @param {Map<string, string>} replacements
 */
export function currentBooking(key, replacements) {
  const seen = new Set();
  let current = replacements.get(key);
  while (typeof current === "string") {
    const next = current.toLowerCase();
    if (!replacements.has(next) || seen.has(next)) break;
    seen.add(next);
    current = replacements.get(next);
  }
  return current;
}

/**
 * Refuse a configured contract that matches retired.* or a superseded address.
 * Comparison is case-insensitive. The message names the rejected address and the current booking.
 * @param {string | null | undefined} address
 * @param {{ forbidden?: Set<string>, replacements?: Map<string, string> }} book
 */
export function rejectRetiredAddress(address, book = {}) {
  if (!address) return;
  const shown = String(address).trim();
  const key = shown.toLowerCase();
  const forbidden = book.forbidden || forbiddenAddresses(null);
  if (!forbidden.has(key)) return;
  const replacements = book.replacements || replacementAddresses(null);
  const current = currentBooking(key, replacements) || SUPERSEDED_CURRENT[SUPERSEDED.botAttestationEscrow.toLowerCase()];
  const message = `${shown} is retired/superseded. Current booked address is ${current}.`;
  throw Object.assign(new Error(message), {
    status: 400,
    error: "retired_or_superseded_address",
    address: shown,
    current,
  });
}

/**
 * Read the committed Base Sepolia address book.
 * A null Escrow slot is unbooked. A non-address is refused.
 * Mainnet books are refused. This does not query a chain.
 */
export function loadAddressBook(filePath = DEFAULT_ADDRESS_BOOK) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    throw bookError("address_book_unreadable");
  }
  const chainId = Number(raw.chainId);
  if (chainId === 1 || chainId === 8453) {
    throw bookError("mainnet_refused", { chainId });
  }
  if (chainId !== BASE_SEPOLIA_CHAIN_ID || raw.network !== "base-sepolia") {
    throw bookError("wrong_chain", { chainId: raw.chainId });
  }

  const slot = raw.BotAttestationEscrow && typeof raw.BotAttestationEscrow === "object" ? raw.BotAttestationEscrow : {};
  const rawEscrow = slot.address;
  let escrowAddress = null;
  if (rawEscrow !== null && rawEscrow !== undefined && String(rawEscrow).trim() !== "") {
    escrowAddress = optionalAddress(rawEscrow);
    if (!escrowAddress) throw bookError("invalid_escrow_address");
  }

  const bvtRaw = raw.BVT && typeof raw.BVT === "object" ? raw.BVT.address : null;
  const forbidden = forbiddenAddresses(raw);
  const replacements = replacementAddresses(raw);
  const retiredEscrows = new Set([
    SUPERSEDED.botAttestationEscrow.toLowerCase(),
    SUPERSEDED.botAttestationEscrowEscM1.toLowerCase(),
  ]);
  walkAddressFields(raw.retired, (node) => addAddress(retiredEscrows, node.address));
  return {
    chainId: BASE_SEPOLIA_CHAIN_ID,
    network: "base-sepolia",
    escrowAddress,
    escrowBooked: Boolean(escrowAddress),
    escrowStartBlock: optionalStartBlock(slot),
    escrowOwner: optionalAddress(slot.owner),
    disputePanelAddress: optionalAddress(raw.DisputePanel?.address),
    denylistAddress: optionalAddress(raw.Denylist?.address),
    vaultAddress: optionalAddress(raw.Vault?.address),
    coreTimelock: optionalAddress(raw.coreTimelock),
    governanceTimelock: screenedGovernanceTimelock(raw.governanceTimelock, forbidden, replacements),
    bvtAddress: bvtRaw === null || bvtRaw === undefined || String(bvtRaw).trim() === "" ? null : optionalAddress(bvtRaw),
    forbidden,
    replacements,
    retiredEscrows,
  };
}
