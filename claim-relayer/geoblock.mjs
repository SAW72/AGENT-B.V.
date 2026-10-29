// Edge jurisdiction check. Wallet screening stays authoritative.
// Country codes CU, IR, and KP are the broad jurisdiction programs named in
// OFAC FAQ 10 (page dated October 26, 2026). Crimea, the so-called DNR, and
// the so-called LNR are on that list and are not ISO countries. Cloudflare's
// country header is UA for those regions, so the region code is read as well.
// Owner policy (Spencer 2026-10-28) also blocks SY, RU, and VE.
// Unknown location denies. An off-edge request on a public route denies.
// Log only the matched code, the decision, and a timestamp. Never a raw IP.

import { PUBLIC_DENIAL_MESSAGE } from "./sanctions.mjs";

export { PUBLIC_DENIAL_MESSAGE };

/** Confirmed from OFAC FAQ 10 on 2026-10-27. */
export const COMPREHENSIVE_COUNTRY_CODES = Object.freeze(["CU", "IR", "KP"]);

/** Owner policy (Spencer 2026-10-28). Not an OFAC FAQ 10 comprehensive program. */
export const OWNER_POLICY_COUNTRY_CODES = Object.freeze(["SY", "RU", "VE"]);

const COMPREHENSIVE = new Set(COMPREHENSIVE_COUNTRY_CODES);
const OWNER_POLICY = new Set(OWNER_POLICY_COUNTRY_CODES);

const REGION_CODE = {
  "43": "UA-43",
  "14": "UA-14",
  "09": "UA-09",
  "9": "UA-09",
  "UA-43": "UA-43",
  "UA-14": "UA-14",
  "UA-09": "UA-09",
};

const REGION_NAME = [
  ["crimea", "UA-43"],
  ["donetsk", "UA-14"],
  ["donetska", "UA-14"],
  ["luhansk", "UA-09"],
  ["luhanska", "UA-09"],
  ["lugansk", "UA-09"],
];

export const PROGRAM_NOTE = "OFAC FAQ 10, date updated October 26, 2026. Confirmed 2026-10-27.";

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

/**
 * @param {{ country?: string, regionCode?: string, region?: string, edge?: boolean, publicRoute?: boolean, at?: number }} input
 * Unknown location denies. Off-edge on a public route denies. Do not skip.
 */
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

function readHeader(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") return headers.get(name) || "";
  const value = headers[name.toLowerCase()] ?? headers[name];
  if (Array.isArray(value)) return value[0] || "";
  return value || "";
}

export function geoInputFromHeaders(headers, cf, edge) {
  return {
    country: readHeader(headers, "CF-IPCountry") || cf?.country || "",
    regionCode: readHeader(headers, "CF-Region-Code") || cf?.regionCode || "",
    region: readHeader(headers, "CF-Region") || cf?.region || "",
    edge,
  };
}
