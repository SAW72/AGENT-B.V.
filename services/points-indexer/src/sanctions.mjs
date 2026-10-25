// Checklist #7 screen. A match is ineligible and is kept. A clear wallet stays unverified.
// This module has no Node builtins so the worker can import it.
// The publication is streamed. Only the issue date and digital-currency addresses are kept.
// A Workers isolate has 128 MB. SANCTIONS_MAX_BYTES is how much may be read, not buffered.

export const SDN_ADVANCED_URL = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN_ADVANCED.XML";
export const SANCTIONS_REFRESH_MS = 24 * 60 * 60 * 1000;
export const SANCTIONS_MATCH = "sanctions_match";
export const SANCTIONS_MAX_BYTES = 160_000_000;
/** Extracted issue date plus digital-currency features. Far under the 128 MB isolate limit. */
export const SANCTIONS_RETAINED_MAX_BYTES = 8_000_000;

export const SANCTIONS_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS sanctions_cache (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    fetched_at INTEGER,
    source TEXT,
    list_version TEXT,
    addresses_json TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS sanctions_wallets (
    wallet TEXT PRIMARY KEY,
    reason TEXT NOT NULL,
    checked_at INTEGER NOT NULL,
    list_version TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS sanctions_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet TEXT NOT NULL,
    result TEXT NOT NULL,
    reason TEXT NOT NULL,
    checked_at INTEGER NOT NULL,
    list_version TEXT,
    source TEXT,
    persisted INTEGER NOT NULL
  )`,
];

export const SANCTIONS_READ_CACHE =
  "SELECT fetched_at, source, list_version, addresses_json FROM sanctions_cache WHERE id = 1";
export const SANCTIONS_WRITE_CACHE =
  `INSERT INTO sanctions_cache(id, fetched_at, source, list_version, addresses_json)
   VALUES(1, ?, ?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET
     fetched_at = excluded.fetched_at,
     source = excluded.source,
     list_version = excluded.list_version,
     addresses_json = excluded.addresses_json`;
export const SANCTIONS_READ_WALLETS = "SELECT wallet FROM sanctions_wallets";
export const SANCTIONS_INSERT_WALLET =
  `INSERT INTO sanctions_wallets(wallet, reason, checked_at, list_version)
   VALUES(?, ?, ?, ?)
   ON CONFLICT(wallet) DO NOTHING`;
export const SANCTIONS_INSERT_CHECK =
  `INSERT INTO sanctions_checks(wallet, result, reason, checked_at, list_version, source, persisted)
   VALUES(?, ?, ?, ?, ?, ?, ?)`;

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function sanctionsError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function decodeXml(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'");
}

export function normalizeSanctionsAddress(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (EVM_ADDRESS.test(trimmed)) return trimmed.toLowerCase();
  return trimmed;
}

export function cacheIsFresh(fetchedAt, now, refreshMs = SANCTIONS_REFRESH_MS) {
  if (!Number.isFinite(fetchedAt) || !Number.isFinite(now)) return false;
  if (!Number.isFinite(refreshMs) || refreshMs <= 0) return false;
  const age = now - fetchedAt;
  return age >= 0 && age < refreshMs;
}

function digitalCurrencyTypeIds(xml) {
  const ids = new Set();
  const re = /<FeatureType\b([^>]*)>([^<]*)<\/FeatureType>/g;
  for (const match of xml.matchAll(re)) {
    const label = decodeXml(match[2]).trim();
    if (!label.startsWith("Digital Currency Address")) continue;
    const id = /\bID="(\d+)"/.exec(match[1]);
    if (id) ids.add(id[1]);
  }
  return ids;
}

function listVersionFrom(xml) {
  const start = xml.indexOf("<DateOfIssue");
  if (start === -1) return "undated";
  const end = xml.indexOf("</DateOfIssue>", start);
  if (end === -1) return "undated";
  const block = xml.slice(start, end);
  const year = /<Year>(\d{4})<\/Year>/.exec(block);
  const month = /<Month>(\d{1,2})<\/Month>/.exec(block);
  const day = /<Day>(\d{1,2})<\/Day>/.exec(block);
  if (!year || !month || !day) return "undated";
  const monthNumber = Number(month[1]);
  const dayNumber = Number(day[1]);
  if (monthNumber < 1 || monthNumber > 12 || dayNumber < 1 || dayNumber > 31) return "undated";
  return `${year[1]}-${String(monthNumber).padStart(2, "0")}-${String(dayNumber).padStart(2, "0")}`;
}

function versionDetails(body) {
  const found = [];
  let cursor = 0;
  while (cursor < body.length) {
    const start = body.indexOf("<VersionDetail", cursor);
    if (start === -1) break;
    const openEnd = body.indexOf(">", start);
    if (openEnd === -1) break;
    if (body[openEnd - 1] === "/") {
      cursor = openEnd + 1;
      continue;
    }
    const close = body.indexOf("</VersionDetail>", openEnd);
    if (close === -1) break;
    found.push(decodeXml(body.slice(openEnd + 1, close)));
    cursor = close + "</VersionDetail>".length;
  }
  return found;
}

export function parseSdnAdvancedXml(xml) {
  if (typeof xml !== "string" || xml.trim() === "") throw sanctionsError("sanctions_xml_empty");
  if (!xml.includes("</Sanctions>")) throw sanctionsError("sanctions_xml_invalid");
  const typeIds = digitalCurrencyTypeIds(xml);
  if (typeIds.size === 0) throw sanctionsError("sanctions_xml_invalid");
  const addresses = new Set();
  let cursor = 0;
  while (cursor < xml.length) {
    const start = xml.indexOf("<Feature", cursor);
    if (start === -1) break;
    const next = xml[start + "<Feature".length];
    if (next !== " " && next !== ">" && next !== "/") {
      cursor = start + "<Feature".length;
      continue;
    }
    const openEnd = xml.indexOf(">", start);
    if (openEnd === -1) break;
    if (xml[openEnd - 1] === "/") {
      cursor = openEnd + 1;
      continue;
    }
    const close = xml.indexOf("</Feature>", openEnd);
    if (close === -1) break;
    const openTag = xml.slice(start, openEnd + 1);
    const typeId = /\bFeatureTypeID="(\d+)"/.exec(openTag);
    if (typeId && typeIds.has(typeId[1])) {
      for (const detail of versionDetails(xml.slice(openEnd + 1, close))) {
        const address = normalizeSanctionsAddress(detail);
        if (address) addresses.add(address);
      }
    }
    cursor = close + "</Feature>".length;
  }
  return {
    listVersion: listVersionFrom(xml),
    addresses: [...addresses].sort(),
  };
}

function storedAddresses(cacheRow) {
  if (!cacheRow || typeof cacheRow.addresses_json !== "string") return null;
  try {
    const parsed = JSON.parse(cacheRow.addresses_json);
    if (!Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function screenFromStored(cacheRow, walletRows, now = Date.now()) {
  const screen = {
    addresses: new Set(),
    persisted: new Set(),
    listReady: false,
    listVersion: null,
    source: null,
    memo: new Map(),
    checkedAt: now,
  };
  const stored = storedAddresses(cacheRow);
  if (stored) {
    for (const item of stored) {
      const address = normalizeSanctionsAddress(String(item));
      if (address) screen.addresses.add(address);
    }
    screen.listReady = true;
    screen.listVersion = cacheRow.list_version == null ? null : String(cacheRow.list_version);
    screen.source = cacheRow.source == null ? null : String(cacheRow.source);
  }
  for (const row of walletRows ?? []) {
    const wallet = normalizeSanctionsAddress(String(row?.wallet ?? ""));
    if (wallet) screen.persisted.add(wallet);
  }
  return screen;
}

// A stored match stays a match after the list drops the address or the list is down.
// A missing list is unavailable, not a clear.
export function decideSanctions(wallet, { addresses, persisted, listReady }) {
  const normalized = normalizeSanctionsAddress(wallet);
  if (persisted && persisted.has(normalized)) {
    return { result: "match", reason: SANCTIONS_MATCH, persisted: true };
  }
  if (!listReady) return { result: "unavailable", reason: "ofac_unconfigured", persisted: false };
  if (addresses && addresses.has(normalized)) {
    return { result: "match", reason: SANCTIONS_MATCH, persisted: false };
  }
  return { result: "clear", reason: "clear", persisted: false };
}

export function eligibilityFromDecision(decision) {
  if (decision?.result === "match") {
    return {
      points: 0,
      eligibility_status: "ineligible",
      eligibility_reason: SANCTIONS_MATCH,
      points_withheld: 1,
    };
  }
  return {
    points: 0,
    eligibility_status: "unverified",
    eligibility_reason: "ofac_unconfigured",
    points_withheld: 1,
  };
}

export function applySanctionsDecision(row, decision) {
  const eligibility = eligibilityFromDecision(decision);
  row.points = eligibility.points;
  row.eligibility_status = eligibility.eligibility_status;
  row.eligibility_reason = eligibility.eligibility_reason;
  row.points_withheld = eligibility.points_withheld;
  return row;
}

export function noteDecision(screen, wallet) {
  const key = normalizeSanctionsAddress(wallet);
  if (screen.memo.has(key)) return { decision: screen.memo.get(key), first: false };
  const decision = decideSanctions(key, screen);
  screen.memo.set(key, decision);
  if (decision.result === "match") screen.persisted.add(key);
  return { decision, first: true };
}

export function forgetNotedDecision(screen, wallet, decision) {
  const key = normalizeSanctionsAddress(wallet);
  screen.memo.delete(key);
  if (decision?.result === "match" && decision.persisted !== true) screen.persisted.delete(key);
}

export function sanctionsCheckParams(screen, wallet, decision) {
  return {
    wallet: normalizeSanctionsAddress(wallet),
    result: decision.result,
    reason: decision.reason,
    checkedAt: screen.checkedAt,
    listVersion: screen.listVersion,
    source: screen.source,
    persisted: decision.persisted ? 1 : 0,
    storeWallet: decision.result === "match" && decision.persisted !== true,
  };
}

export function sanctionsCheckLog(screen, wallet, decision) {
  return {
    message: "sanctions_check",
    wallet: normalizeSanctionsAddress(wallet),
    result: decision.result,
    reason: decision.reason,
    persisted: decision.persisted === true,
    listVersion: screen.listVersion,
  };
}

function headerValue(headers, name) {
  if (!headers || typeof headers.get !== "function") return null;
  const value = headers.get(name);
  return value == null ? null : String(value);
}

const ELEMENT_CAP = 256 * 1024;

function tagBoundary(text, token) {
  const next = text[token.length];
  if (next === undefined) return false;
  return next === ">" || next === " " || next === "/" || next === "\n" || next === "\r" || next === "\t";
}

function isOpenFeature(text) {
  return text.startsWith("<Feature") && tagBoundary(text, "<Feature");
}

function needsMore(text) {
  if (!text.startsWith("<") || text.length > 64) return false;
  if (text === "<Feature" || text === "<FeatureType" || text === "<DateOfIssue" || text === "</Feature") return true;
  return ["</Sanctions>", "<FeatureType", "<DateOfIssue", "<Feature", "</Feature>"].some(
    (token) => token.startsWith(text) && text.length < token.length,
  );
}

/**
 * Stream the SDN advanced publication and return a small document that contains
 * the issue date, digital-currency feature types, and those features only.
 * A feature whose type id has not been declared yet is an invalid list.
 * Callers still run parseSdnAdvancedXml, so a partial extract cannot look like a clear list.
 * @param {number} byteCap
 */
function createSdnSlicer(byteCap) {
  let pending = "";
  let readBytes = 0;
  let retained = 0;
  const parts = [];
  const digitalIds = new Set();
  const seenTypeIds = new Set();
  let sawClose = false;
  let mode = "scan";
  let depth = 0;
  let kept = "";

  function add(text) {
    retained += text.length;
    if (retained > SANCTIONS_RETAINED_MAX_BYTES) throw sanctionsError("sanctions_too_large");
    parts.push(text);
  }

  function rememberType(element) {
    const match = /<FeatureType\b([^>]*)>([^<]*)<\/FeatureType>/.exec(element);
    if (!match) throw sanctionsError("sanctions_xml_invalid");
    const id = /\bID="(\d+)"/.exec(match[1]);
    if (!id) throw sanctionsError("sanctions_xml_invalid");
    seenTypeIds.add(id[1]);
    if (decodeXml(match[2]).trim().startsWith("Digital Currency Address")) {
      digitalIds.add(id[1]);
      add(element);
    }
  }

  function appendKept(text) {
    if (mode !== "keep" || text.length === 0) return;
    if (kept.length + text.length > ELEMENT_CAP) throw sanctionsError("sanctions_too_large");
    kept += text;
  }

  function addBytes(size) {
    readBytes += size;
    if (readBytes > byteCap) throw sanctionsError("sanctions_too_large");
  }

  function feed(text) {
    if (text) pending += text;
    let progressed = true;
    while (pending.length > 0 && progressed) {
      progressed = mode === "scan" ? scan() : walkElement();
    }
  }

  function scan() {
    let from = 0;
    while (from < pending.length) {
      const start = pending.indexOf("<", from);
      if (start === -1) {
        pending = "";
        return false;
      }
      const rest = pending.slice(start);
      if (rest.startsWith("</Sanctions>")) {
        sawClose = true;
        pending = rest.slice("</Sanctions>".length);
        return true;
      }
      if (rest.startsWith("<FeatureType") && tagBoundary(rest, "<FeatureType")) {
        pending = rest;
        return takeSimple("FeatureType");
      }
      if (rest.startsWith("<DateOfIssue") && tagBoundary(rest, "<DateOfIssue")) {
        pending = rest;
        return takeSimple("DateOfIssue");
      }
      if (isOpenFeature(rest)) {
        pending = rest;
        return beginFeature();
      }
      if (needsMore(rest)) {
        pending = rest;
        return false;
      }
      from = start + 1;
    }
    pending = "";
    return false;
  }

  function takeSimple(name) {
    const close = `</${name}>`;
    const end = pending.indexOf(close);
    if (end === -1) {
      if (pending.length > ELEMENT_CAP) throw sanctionsError("sanctions_too_large");
      return false;
    }
    const element = pending.slice(0, end + close.length);
    pending = pending.slice(element.length);
    if (name === "FeatureType") rememberType(element);
    else add(element);
    return true;
  }

  function beginFeature() {
    const openEnd = pending.indexOf(">");
    if (openEnd === -1) {
      if (pending.length > ELEMENT_CAP) throw sanctionsError("sanctions_too_large");
      return false;
    }
    const openTag = pending.slice(0, openEnd + 1);
    const typeId = /\bFeatureTypeID="(\d+)"/.exec(openTag);
    if (!typeId || !seenTypeIds.has(typeId[1])) throw sanctionsError("sanctions_xml_invalid");
    const digital = digitalIds.has(typeId[1]);
    pending = pending.slice(openTag.length);
    if (openTag.endsWith("/>")) {
      if (digital) add(openTag);
      return true;
    }
    mode = digital ? "keep" : "drop";
    depth = 1;
    kept = digital ? openTag : "";
    return true;
  }

  function keepBefore(start, extra = "") {
    if (mode !== "keep") return;
    appendKept(extra ? pending.slice(0, start) + extra : pending.slice(0, start));
  }

  function walkElement() {
    let from = 0;
    while (from < pending.length) {
      const start = pending.indexOf("<", from);
      if (start === -1) {
        keepBefore(pending.length);
        pending = "";
        return false;
      }
      const rest = pending.slice(start);
      if (isOpenFeature(rest)) {
        const openEnd = rest.indexOf(">");
        if (openEnd === -1) {
          keepBefore(start);
          pending = rest;
          if (pending.length > ELEMENT_CAP) throw sanctionsError("sanctions_too_large");
          return false;
        }
        const openTag = rest.slice(0, openEnd + 1);
        keepBefore(start, openTag);
        pending = rest.slice(openTag.length);
        if (!openTag.endsWith("/>")) depth += 1;
        return true;
      }
      if (rest.startsWith("</Feature>")) {
        keepBefore(start, "</Feature>");
        pending = rest.slice("</Feature>".length);
        depth -= 1;
        if (depth === 0) {
          if (mode === "keep") add(kept);
          kept = "";
          mode = "scan";
        }
        return true;
      }
      if (needsMore(rest)) {
        keepBefore(start);
        pending = rest;
        return false;
      }
      from = start + 1;
    }
    keepBefore(pending.length);
    pending = "";
    return false;
  }

  function finish() {
    feed("");
    if (mode !== "scan") throw sanctionsError("sanctions_xml_invalid");
    if (!sawClose) {
      if (parts.length === 0 && pending.trim() === "") throw sanctionsError("sanctions_xml_empty");
      throw sanctionsError("sanctions_xml_invalid");
    }
    return `<Sanctions>${parts.join("")}</Sanctions>`;
  }

  return { addBytes, feed, finish };
}

async function readSdnSlice(response, byteCap) {
  const slicer = createSdnSlicer(byteCap);
  const body = response.body;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const step = await reader.read();
        if (step.done) break;
        const value = step.value;
        const size = value?.byteLength ?? value?.length ?? 0;
        if (size > 0) slicer.addBytes(size);
        if (value && size > 0) slicer.feed(decoder.decode(value, { stream: true }));
      }
      slicer.feed(decoder.decode());
      return slicer.finish();
    } catch (error) {
      try {
        await reader.cancel();
      } catch {
        // The read already failed closed.
      }
      throw error;
    }
  }
  if (typeof response.text !== "function") throw sanctionsError("sanctions_xml_invalid");
  const text = await response.text();
  const size = new TextEncoder().encode(text).byteLength;
  slicer.addBytes(size);
  slicer.feed(text);
  return slicer.finish();
}

export async function fetchSdnAdvancedXml(fetchImpl, url = SDN_ADVANCED_URL, byteCap = SANCTIONS_MAX_BYTES) {
  const response = await fetchImpl(url, {
    redirect: "follow",
    headers: {
      accept: "application/xml,text/xml,*/*",
      "user-agent": "Agent-B.V. points-indexer",
    },
  });
  if (!response || response.ok !== true) throw sanctionsError("sanctions_http");
  const cap = byteCap > 0 ? byteCap : SANCTIONS_MAX_BYTES;
  const declared = Number(headerValue(response.headers, "content-length"));
  if (Number.isFinite(declared) && declared > cap) throw sanctionsError("sanctions_too_large");
  return readSdnSlice(response, cap);
}

export async function refreshParsedList(fetchImpl, url, now, refreshMs, cacheRow) {
  const addresses = storedAddresses(cacheRow);
  const fetchedAt = cacheRow ? Number(cacheRow.fetched_at) : Number.NaN;
  if (addresses && cacheIsFresh(fetchedAt, now, refreshMs)) {
    return {
      refreshed: false,
      failed: false,
      listVersion: cacheRow.list_version == null ? null : String(cacheRow.list_version),
      count: addresses.length,
      addressesJson: null,
      fetchedAt: null,
    };
  }
  try {
    const xml = await fetchSdnAdvancedXml(fetchImpl, url);
    const parsed = parseSdnAdvancedXml(xml);
    return {
      refreshed: true,
      failed: false,
      listVersion: parsed.listVersion,
      count: parsed.addresses.length,
      addressesJson: JSON.stringify(parsed.addresses),
      fetchedAt: now,
    };
  } catch {
    return {
      refreshed: false,
      failed: true,
      listVersion: cacheRow?.list_version == null ? null : String(cacheRow.list_version),
      count: null,
      addressesJson: null,
      fetchedAt: null,
    };
  }
}
