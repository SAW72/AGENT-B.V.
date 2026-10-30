// Pages cannot rely on a file outside this project. The country set is checked
// against claim-relayer/geoblock.mjs by scripts/geoblock-parity.test.mjs.
// Wallet screening stays authoritative. Log only the matched code, decision, and time.
// Owner policy (Spencer 2026-10-28) also blocks SY, RU, and VE.
// Unknown location denies. An off-edge request on a public route denies.
// UA with an empty or missing region denies.
// Sevastopol is ISO region UA-40 and is denied with Crimea, the so-called DNR, and the so-called LNR.

export const PUBLIC_DENIAL_MESSAGE = "Agent-B.V. isn't available for this wallet or location. If you think this is a mistake, contact hello@stewardoftheking.com.";

export const COMPREHENSIVE_COUNTRY_CODES = Object.freeze(["CU", "IR", "KP"]);

/** Owner policy (Spencer 2026-10-28). Not an OFAC FAQ 10 comprehensive program. */
export const OWNER_POLICY_COUNTRY_CODES = Object.freeze(["SY", "RU", "VE"]);

const COMPREHENSIVE = new Set(COMPREHENSIVE_COUNTRY_CODES);
const OWNER_POLICY = new Set(OWNER_POLICY_COUNTRY_CODES);

const REGION_CODE = {
  "43": "UA-43",
  "40": "UA-40",
  "14": "UA-14",
  "09": "UA-09",
  "9": "UA-09",
  "UA-43": "UA-43",
  "UA-40": "UA-40",
  "UA-14": "UA-14",
  "UA-09": "UA-09",
};

const REGION_NAME = [
  ["crimea", "UA-43"],
  ["sevastopol", "UA-40"],
  ["sevastopol city", "UA-40"],
  ["city of sevastopol", "UA-40"],
  ["donetsk", "UA-14"],
  ["donetska", "UA-14"],
  ["luhansk", "UA-09"],
  ["luhanska", "UA-09"],
  ["lugansk", "UA-09"],
];

function countryCode(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{2}$/.test(trimmed)) return "";
  return trimmed;
}

function regionJurisdiction(regionCode, regionName) {
  const code = String(regionCode || "").trim().toUpperCase();
  if (REGION_CODE[code]) return REGION_CODE[code];
  const name = String(regionName || "").trim().toLowerCase();
  if (!name) return "";
  for (const [needle, jurisdiction] of REGION_NAME) {
    if (name === needle) return jurisdiction;
  }
  return "";
}

export function decideGeoblock(input = {}) {
  const at = Number.isFinite(input.at) ? input.at : Date.now();
  const country = countryCode(input.country);
  const edge = input.edge === true;
  if (input.publicRoute === true && !edge) {
    return { decision: "deny", country: country || "missing", at };
  }
  if (!country || country === "XX" || country === "T1") {
    return { decision: "deny", country: country || "missing", at };
  }
  if (COMPREHENSIVE.has(country) || OWNER_POLICY.has(country)) return { decision: "deny", country, at };
  if (country === "UA") {
    const jurisdiction = regionJurisdiction(input.regionCode, input.region);
    if (jurisdiction) return { decision: "deny", country: jurisdiction, at };
    const regionCode = String(input.regionCode || "").trim();
    const regionName = String(input.region || "").trim();
    if (!regionCode && !regionName) return { decision: "deny", country: "UA", at };
  }
  return { decision: "allow", country, at };
}

export function geoLog(decision) {
  return {
    message: "geo_screen",
    country: decision.country,
    decision: decision.decision,
    at: decision.at,
  };
}
