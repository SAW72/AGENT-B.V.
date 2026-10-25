// Checklist #7 screen. A match is ineligible and is kept. A clear wallet stays unverified.
// This module has no Node builtins so the worker can import it.
// The publication is streamed. Only the issue date and digital-currency addresses are kept.
// A Workers isolate has 128 MB. SANCTIONS_MAX_BYTES is how much may be read, not buffered.
// Retained text is copied. A slice of a read chunk must not keep that chunk alive.

export const SDN_ADVANCED_URL = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN_ADVANCED.XML";
export const SDN_HOST = "sanctionslistservice.ofac.treas.gov";
export const SANCTIONS_REFRESH_MS = 24 * 60 * 60 * 1000;
/** A cached list older than this is unavailable. It must not clear a wallet. */
export const SANCTIONS_MAX_AGE_MS = 48 * 60 * 60 * 1000;
/** Fewer parsed or cached addresses than this is unavailable. Default rejects an empty list. */
export const SANCTIONS_MIN_ADDRESSES = 1;
/** Covers the fetch and the streamed read. A hung download fails closed. */
export const SANCTIONS_FETCH_TIMEOUT_MS = 60_000;
export const SANCTIONS_MATCH = "sanctions_match";
export const SANCTIONS_MAX_BYTES = 160_000_000;
/** Extracted issue date plus digital-currency features. Far under the 128 MB isolate limit. */
export const SANCTIONS_RETAINED_MAX_BYTES = 8_000_000;
/** FeatureType ids kept while streaming. The publication declares far fewer. */
export const SANCTIONS_MAX_FEATURE_TYPES = 1024;
/** One FeatureType id. Published ids are short integers. */
export const SANCTIONS_MAX_TYPE_ID_CHARS = 32;
/** One element. Applies when the end tag is already buffered and when it is not. */
export const SANCTIONS_ELEMENT_MAX_BYTES = 256 * 1024;
/** Decoded working window. A larger chunk is split so the window stays this size. */
export const SANCTIONS_WINDOW_MAX_BYTES = 64 * 1024;

const SANCTIONS_MAX_REDIRECTS = 5;

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

// A sliced string keeps its parent buffer. Parsing the JSON form returns a new string.
function copyString(value) {
  if (typeof value !== "string" || value.length === 0) return "";
  return JSON.parse(JSON.stringify(value));
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

function resolvedMin(value) {
  if (value == null) return SANCTIONS_MIN_ADDRESSES;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
  return value;
}

function resolvedMaxAge(value) {
  if (value == null) return SANCTIONS_MAX_AGE_MS;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

/** A list fetched in the future, or older than the max, is not usable. */
export function listWithinMaxAge(fetchedAt, now, maxAgeMs = SANCTIONS_MAX_AGE_MS) {
  const limit = resolvedMaxAge(maxAgeMs);
  if (limit == null || !Number.isFinite(fetchedAt) || !Number.isFinite(now)) return false;
  const age = now - fetchedAt;
  return age >= 0 && age <= limit;
}

/**
 * Characters that may follow `<Feature` in both the parser and the stream filter.
 * XML whitespace plus the end of the tag name. `<FeatureType` does not match.
 */
function featureFollows(next) {
  return next === ">" || next === " " || next === "/" || next === "\n" || next === "\r" || next === "\t";
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

export function parseSdnAdvancedXml(xml, options = {}) {
  if (typeof xml !== "string" || xml.trim() === "") throw sanctionsError("sanctions_xml_empty");
  if (!xml.includes("</Sanctions>")) throw sanctionsError("sanctions_xml_invalid");
  const typeIds = digitalCurrencyTypeIds(xml);
  if (typeIds.size === 0) throw sanctionsError("sanctions_xml_invalid");
  const minAddresses = resolvedMin(options.minAddresses);
  const addresses = new Set();
  let cursor = 0;
  while (cursor < xml.length) {
    const start = xml.indexOf("<Feature", cursor);
    if (start === -1) break;
    const next = xml[start + "<Feature".length];
    if (!featureFollows(next)) {
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
        const address = copyString(normalizeSanctionsAddress(detail));
        if (address) addresses.add(address);
      }
    }
    cursor = close + "</Feature>".length;
  }
  const list = [...addresses].sort();
  // An empty or implausibly small list must not clear every wallet.
  if (minAddresses == null || list.length < minAddresses) throw sanctionsError("sanctions_unavailable");
  return {
    listVersion: listVersionFrom(xml),
    addresses: list,
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

export function screenFromStored(cacheRow, walletRows, now = Date.now(), options = {}) {
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
  const minAddresses = resolvedMin(options.minAddresses);
  const fetchedAt = cacheRow ? Number(cacheRow.fetched_at) : Number.NaN;
  const ageOk = listWithinMaxAge(fetchedAt, now, options.maxAgeMs);
  if (stored && minAddresses != null && ageOk) {
    for (const item of stored) {
      const address = normalizeSanctionsAddress(String(item));
      if (address) screen.addresses.add(address);
    }
    // Too few addresses is the same as no list: unavailable, not a clear.
    if (screen.addresses.size >= minAddresses) {
      screen.listReady = true;
      screen.listVersion = cacheRow.list_version == null ? null : String(cacheRow.list_version);
      screen.source = cacheRow.source == null ? null : String(cacheRow.source);
    } else {
      screen.addresses.clear();
    }
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

function tagBoundary(text, token) {
  const next = text[token.length];
  if (next === undefined) return false;
  return featureFollows(next);
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
  let pendingStart = 0;
  let readBytes = 0;
  let retained = 0;
  const parts = [];
  const digitalIds = new Set();
  const seenTypeIds = new Set();
  let sawClose = false;
  let mode = "scan";
  let depth = 0;
  let kept = "";
  const utf8 = new TextEncoder();

  function pendingLength() {
    return pending.length - pendingStart;
  }

  function charAt(offset) {
    return pending[pendingStart + offset];
  }

  function startsWithAt(offset, token) {
    return pending.startsWith(token, pendingStart + offset);
  }

  function pendingIndexOf(token, from = 0) {
    const found = pending.indexOf(token, pendingStart + from);
    if (found < 0) return -1;
    return found - pendingStart;
  }

  function boundaryAt(offset, token) {
    const next = charAt(offset + token.length);
    if (next === undefined) return false;
    return tagBoundary(token + next, token);
  }

  function isFeatureAt(offset) {
    // <Comment, <Profile, and <Country are eight bytes and share a boundary character.
    if (!startsWithAt(offset, "<Feature")) return false;
    return boundaryAt(offset, "<Feature");
  }

  function needsMoreAt(offset) {
    const available = pendingLength() - offset;
    if (available <= 0 || charAt(offset) !== "<" || available > 64) return false;
    const text = copyString(pending.slice(pendingStart + offset, pendingStart + offset + available));
    return needsMore(text);
  }

  function copySpan(offset, length) {
    if (length <= 0) return "";
    return copyString(pending.slice(pendingStart + offset, pendingStart + offset + length));
  }

  function consume(count) {
    if (count <= 0) return;
    if (count >= pendingLength()) {
      pending = "";
      pendingStart = 0;
      return;
    }
    pendingStart += count;
    if (pendingStart >= SANCTIONS_WINDOW_MAX_BYTES && pendingStart * 2 >= pending.length) {
      pending = copyString(pending.slice(pendingStart));
      pendingStart = 0;
    }
  }

  function appendPending(chunk) {
    const copied = copyString(chunk);
    if (copied.length === 0) return;
    if (pendingStart > 0) {
      pending = copyString(pending.slice(pendingStart)) + copied;
      pendingStart = 0;
    } else {
      pending += copied;
    }
    if (pendingLength() > SANCTIONS_ELEMENT_MAX_BYTES + SANCTIONS_WINDOW_MAX_BYTES) {
      throw sanctionsError("sanctions_too_large");
    }
  }

  function charge(bytes) {
    if (retained + bytes > SANCTIONS_RETAINED_MAX_BYTES) throw sanctionsError("sanctions_too_large");
    retained += bytes;
  }

  function add(text) {
    const copied = copyString(text);
    charge(utf8.encode(copied).byteLength);
    parts.push(copied);
  }

  function rememberType(element) {
    const match = /<FeatureType\b([^>]*)>([^<]*)<\/FeatureType>/.exec(element);
    if (!match) throw sanctionsError("sanctions_xml_invalid");
    const id = /\bID="(\d+)"/.exec(match[1]);
    if (!id) throw sanctionsError("sanctions_xml_invalid");
    const idText = copyString(id[1]);
    if (idText.length > SANCTIONS_MAX_TYPE_ID_CHARS) throw sanctionsError("sanctions_too_large");
    if (!seenTypeIds.has(idText)) {
      if (seenTypeIds.size >= SANCTIONS_MAX_FEATURE_TYPES) throw sanctionsError("sanctions_too_large");
      charge(utf8.encode(idText).byteLength);
      seenTypeIds.add(idText);
    }
    if (decodeXml(match[2]).trim().startsWith("Digital Currency Address")) {
      digitalIds.add(idText);
      add(element);
    }
  }

  function appendKept(text) {
    if (mode !== "keep" || text.length === 0) return;
    const copied = copyString(text);
    if (kept.length + copied.length > SANCTIONS_ELEMENT_MAX_BYTES) throw sanctionsError("sanctions_too_large");
    kept += copied;
  }

  function addBytes(size) {
    readBytes += size;
    if (readBytes > byteCap) throw sanctionsError("sanctions_too_large");
  }

  function pump() {
    let progressed = true;
    while (pendingLength() > 0 && progressed) {
      progressed = mode === "scan" ? scan() : walkElement();
    }
  }

  function feed(text) {
    if (typeof text === "string" && text.length > 0) {
      let offset = 0;
      while (offset < text.length) {
        const end = Math.min(text.length, offset + SANCTIONS_WINDOW_MAX_BYTES);
        appendPending(text.slice(offset, end));
        offset = end;
        pump();
      }
      return;
    }
    pump();
  }

  function scan() {
    let from = 0;
    while (from < pendingLength()) {
      const start = pendingIndexOf("<", from);
      if (start === -1) {
        consume(pendingLength());
        return false;
      }
      if (start > from) {
        consume(start);
        from = 0;
        continue;
      }
      if (startsWithAt(start, "</Sanctions>")) {
        sawClose = true;
        consume(start + "</Sanctions>".length);
        return true;
      }
      if (startsWithAt(start, "<FeatureType") && boundaryAt(start, "<FeatureType")) {
        consume(start);
        return takeSimple("FeatureType");
      }
      if (startsWithAt(start, "<DateOfIssue") && boundaryAt(start, "<DateOfIssue")) {
        consume(start);
        return takeSimple("DateOfIssue");
      }
      if (isFeatureAt(start)) {
        consume(start);
        return beginFeature();
      }
      if (needsMoreAt(start)) {
        consume(start);
        return false;
      }
      from = start + 1;
    }
    consume(pendingLength());
    return false;
  }

  function takeSimple(name) {
    const close = `</${name}>`;
    const end = pendingIndexOf(close);
    if (end === -1) {
      if (pendingLength() > SANCTIONS_ELEMENT_MAX_BYTES) throw sanctionsError("sanctions_too_large");
      return false;
    }
    const elementLength = end + close.length;
    if (elementLength > SANCTIONS_ELEMENT_MAX_BYTES) throw sanctionsError("sanctions_too_large");
    const element = copySpan(0, elementLength);
    consume(elementLength);
    if (name === "FeatureType") rememberType(element);
    else add(element);
    return true;
  }

  function beginFeature() {
    const openEnd = pendingIndexOf(">");
    if (openEnd === -1) {
      if (pendingLength() > SANCTIONS_ELEMENT_MAX_BYTES) throw sanctionsError("sanctions_too_large");
      return false;
    }
    const openLength = openEnd + 1;
    if (openLength > SANCTIONS_ELEMENT_MAX_BYTES) throw sanctionsError("sanctions_too_large");
    const openTag = copySpan(0, openLength);
    const typeId = /\bFeatureTypeID="(\d+)"/.exec(openTag);
    if (!typeId || !seenTypeIds.has(typeId[1])) throw sanctionsError("sanctions_xml_invalid");
    const digital = digitalIds.has(typeId[1]);
    consume(openLength);
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
    const head = start > 0 ? copySpan(0, start) : "";
    appendKept(extra ? head + extra : head);
  }

  function walkElement() {
    let from = 0;
    while (from < pendingLength()) {
      const start = pendingIndexOf("<", from);
      if (start === -1) {
        keepBefore(pendingLength());
        consume(pendingLength());
        return false;
      }
      if (isFeatureAt(start)) {
        const openEnd = pendingIndexOf(">", start);
        if (openEnd === -1) {
          keepBefore(start);
          consume(start);
          if (pendingLength() > SANCTIONS_ELEMENT_MAX_BYTES) throw sanctionsError("sanctions_too_large");
          return false;
        }
        const openTag = copySpan(start, openEnd + 1 - start);
        if (openTag.length > SANCTIONS_ELEMENT_MAX_BYTES) throw sanctionsError("sanctions_too_large");
        keepBefore(start, openTag);
        consume(openEnd + 1);
        if (!openTag.endsWith("/>")) depth += 1;
        return true;
      }
      if (startsWithAt(start, "</Feature>")) {
        keepBefore(start, "</Feature>");
        consume(start + "</Feature>".length);
        depth -= 1;
        if (depth === 0) {
          if (mode === "keep") add(kept);
          kept = "";
          mode = "scan";
        }
        return true;
      }
      if (needsMoreAt(start)) {
        keepBefore(start);
        consume(start);
        return false;
      }
      from = start + 1;
    }
    keepBefore(pendingLength());
    consume(pendingLength());
    return false;
  }

  function finish() {
    feed("");
    if (mode !== "scan") throw sanctionsError("sanctions_xml_invalid");
    const tail = pendingStart === 0 ? pending : pending.slice(pendingStart);
    if (!sawClose) {
      if (parts.length === 0 && tail.trim() === "") throw sanctionsError("sanctions_xml_empty");
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
        if (value && size > 0) feedDecoded(slicer, decoder, value);
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

function feedDecoded(slicer, decoder, value) {
  const size = value.byteLength ?? value.length ?? 0;
  if (typeof value.subarray !== "function" || size <= SANCTIONS_WINDOW_MAX_BYTES) {
    slicer.feed(decoder.decode(value, { stream: true }));
    return;
  }
  for (let index = 0; index < size; index += SANCTIONS_WINDOW_MAX_BYTES) {
    const piece = value.subarray(index, Math.min(size, index + SANCTIONS_WINDOW_MAX_BYTES));
    slicer.feed(decoder.decode(piece, { stream: true }));
  }
}

function ofacUrl(value, base) {
  let parsed;
  try {
    parsed = base ? new URL(value, base) : new URL(value);
  } catch {
    throw sanctionsError("sanctions_http");
  }
  if (parsed.protocol !== "https:") throw sanctionsError("sanctions_http");
  if (parsed.hostname.toLowerCase() !== SDN_HOST) throw sanctionsError("sanctions_http");
  if (parsed.port !== "" && parsed.port !== "443") throw sanctionsError("sanctions_http");
  if (parsed.username !== "" || parsed.password !== "") throw sanctionsError("sanctions_http");
  return parsed;
}

function redirectTarget(response, current) {
  const status = Number(response?.status);
  if (status !== 301 && status !== 302 && status !== 303 && status !== 307 && status !== 308) {
    if (response?.type === "opaqueredirect") throw sanctionsError("sanctions_http");
    return null;
  }
  const location = headerValue(response.headers, "location");
  if (location == null || location.trim() === "") throw sanctionsError("sanctions_http");
  return ofacUrl(location.trim(), current);
}

function resolvedTimeout(value) {
  if (value == null) return SANCTIONS_FETCH_TIMEOUT_MS;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw sanctionsError("sanctions_timeout");
  return value;
}

async function fetchOfac(fetchImpl, url, signal) {
  let current = ofacUrl(url);
  for (let hop = 0; hop <= SANCTIONS_MAX_REDIRECTS; hop += 1) {
    const response = await fetchImpl(current.href, {
      redirect: "manual",
      headers: {
        accept: "application/xml,text/xml,*/*",
        "user-agent": "Agent-B.V. points-indexer",
      },
      signal,
    });
    const next = redirectTarget(response, current);
    if (!next) return response;
    if (hop === SANCTIONS_MAX_REDIRECTS) throw sanctionsError("sanctions_http");
    current = next;
  }
  throw sanctionsError("sanctions_http");
}

export async function fetchSdnAdvancedXml(fetchImpl, url = SDN_ADVANCED_URL, byteCap = SANCTIONS_MAX_BYTES, options = {}) {
  const timeoutMs = resolvedTimeout(options.timeoutMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === "function") timer.unref();
  try {
    const response = await fetchOfac(fetchImpl, url, controller.signal);
    if (controller.signal.aborted) throw sanctionsError("sanctions_timeout");
    if (!response || response.ok !== true) throw sanctionsError("sanctions_http");
    const cap = byteCap > 0 ? byteCap : SANCTIONS_MAX_BYTES;
    const declared = Number(headerValue(response.headers, "content-length"));
    if (Number.isFinite(declared) && declared > cap) throw sanctionsError("sanctions_too_large");
    return await readSdnSlice(response, cap);
  } catch (error) {
    if (controller.signal.aborted || error?.code === "sanctions_timeout") throw sanctionsError("sanctions_timeout");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function refreshParsedList(fetchImpl, url, now, refreshMs, cacheRow, options = {}) {
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
    const xml = await fetchSdnAdvancedXml(fetchImpl, url, options.byteCap, {
      timeoutMs: options.timeoutMs,
    });
    const parsed = parseSdnAdvancedXml(xml, { minAddresses: options.minAddresses });
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
