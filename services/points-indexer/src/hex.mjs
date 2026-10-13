export class PointsError extends Error {
  constructor(reason, extra = {}) {
    super(reason);
    this.name = "PointsError";
    this.reason = reason;
    Object.assign(this, extra);
  }
}

export function lowerHex(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim().toLowerCase();
  if (!text.startsWith("0x")) return null;
  return text;
}

export function hexInt(value) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new PointsError("bad_hex");
    return value;
  }
  if (typeof value === "bigint") {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new PointsError("bad_hex");
    return Number(value);
  }
  const text = String(value ?? "").trim();
  if (/^0x[0-9a-f]+$/i.test(text)) {
    const parsed = Number.parseInt(text, 16);
    if (!Number.isSafeInteger(parsed)) throw new PointsError("bad_hex");
    return parsed;
  }
  if (/^[0-9]+$/.test(text)) {
    const parsed = Number(text);
    if (!Number.isSafeInteger(parsed)) throw new PointsError("bad_hex");
    return parsed;
  }
  throw new PointsError("bad_hex");
}

export function asBool(value) {
  return value === true || value === 1 || value === "true" || value === "0x1";
}

export function wordsOf(data) {
  const hex = String(data).toLowerCase().replace(/^0x/, "");
  if (hex.length % 64 !== 0) return [];
  const words = [];
  for (let i = 0; i < hex.length; i += 64) words.push(`0x${hex.slice(i, i + 64)}`);
  return words;
}

export function wordAddress(word) {
  const text = String(word).toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(text)) return null;
  if (!/^0{24}[0-9a-f]{40}$/.test(text)) return null;
  const address = `0x${text.slice(24)}`;
  if (address === "0x0000000000000000000000000000000000000000") return null;
  return address;
}

export function isUniqueError(error) {
  return String(error?.message || error || "").includes("UNIQUE");
}
