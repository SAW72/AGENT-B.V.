import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { HttpRequestError, createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { CHAIN_ID, ESCROW, ESCROW_START_BLOCK, PANEL, isAcceptedChain } from "./constants.mjs";
import { PointsError } from "./hex.mjs";
import { openIndexer } from "./indexer.mjs";
import {
  GETLOGS_MIN_GAP_MS,
  MAX_RETRY_AFTER_MS,
  MAX_SCAN_RETRIES,
  RETRY_BACKOFF_MS,
  createScanPacer,
  scanErrorClass,
  sleepMs,
  textIsHeadLag,
  textIsRateLimit,
} from "./pace.mjs";

export const DEFAULT_RPC_URL = "https://sepolia.base.org";
export const DEFAULT_ESCROW_ADDRESS = "0x3d660502D75f1e97b08c110255921b437A3C4C42";
export const DEFAULT_POLL_MS = 15_000;
export const DEFAULT_LOG_RANGE = 200;
export const DEFAULT_MAX_WINDOWS = 500;
export const DEFAULT_DB_PATH = "points-indexer.sqlite";
export const DEFAULT_HTTP_TIMEOUT_MS = 10_000;
export const DEFAULT_HEALTH_FRESHNESS_POLLS = 3;
export const DEFAULT_USER_AGENT = "Agent-B.V. points-indexer";

const PACE_REASONS = new Set(["rate_limited", "server_error", "network_error", "head_lag"]);

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const URL_PATTERN = /(?:https?|wss?):\/\/\S+/gi;
const ENCODED_URL_PATTERN = /(?:https?|wss?)%3a%2f%2f\S+/gi;
const QUERY_SECRET_PATTERN = /([?&](?:api[_-]?key|access[_-]?token|token|secret|key)=)[^&\s#]*/gi;
const KEY_SEGMENT_PATTERN = /\/([A-Za-z0-9_-]{16,})/g;
const USER_AGENT_SAFE = /^[A-Za-z0-9 .,_+():/-]{1,128}$/;
const GAP_MAX_MS = 60_000;
const TIMEOUT_MAX_MS = 120_000;
const RETRIES_MAX = 8;
const BACKOFF_SLOT_MAX_MS = 30_000;
const BACKOFF_SLOTS_MAX = 8;

function blank(value) {
  return value === undefined || value === null || String(value).trim() === "";
}

function asChainId(value) {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  const text = String(value ?? "").trim();
  if (/^0x[0-9a-f]+$/i.test(text)) return Number.parseInt(text, 16);
  if (/^[0-9]+$/.test(text)) return Number(text);
  return Number.NaN;
}

function positiveInt(value, name) {
  const text = String(value ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(text)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function nonNegativeInt(value) {
  const text = String(value ?? "").trim();
  if (!/^(0|[1-9][0-9]*)$/.test(text)) return null;
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) return null;
  return parsed;
}

function positiveOrNull(value) {
  const parsed = nonNegativeInt(value);
  if (parsed == null || parsed < 1) return null;
  return parsed;
}

function boundedInt(value, min, max) {
  const parsed = nonNegativeInt(value);
  if (parsed == null || parsed < min || parsed > max) return null;
  return parsed;
}

function numericCode(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?[0-9]+$/.test(value)) return Number(value);
  return null;
}

/**
 * Chain and escrow checks shared by loadConfig and start({ config }).
 * Does not dial a network.
 * @param {object} cfg
 */
export function assertConfig(cfg) {
  if (!cfg || typeof cfg !== "object") throw new Error(`CHAIN_ID must be ${CHAIN_ID}`);
  if (cfg.chainId !== CHAIN_ID || !isAcceptedChain(cfg.chainId)) {
    throw new Error(`CHAIN_ID must be ${CHAIN_ID}`);
  }
  const escrowAddress = cfg.escrowAddress;
  if (escrowAddress == null || String(escrowAddress).trim() === "") throw new Error("ESCROW_ADDRESS is missing");
  if (!ADDRESS.test(String(escrowAddress).trim())) throw new Error("ESCROW_ADDRESS is malformed");
  const escrow = String(escrowAddress).trim();
  if (escrow.toLowerCase() === ZERO_ADDRESS) throw new Error("ESCROW_ADDRESS is the zero address");
  if (escrow.toLowerCase() !== ESCROW) throw new Error(`ESCROW_ADDRESS must be ${DEFAULT_ESCROW_ADDRESS}`);
  const logRange = cfg.logRange ?? DEFAULT_LOG_RANGE;
  if (!Number.isInteger(logRange) || logRange < 1) throw new Error("POINTS_LOG_RANGE must be a positive integer");
  const pollMs = cfg.pollMs ?? DEFAULT_POLL_MS;
  if (!Number.isInteger(pollMs) || pollMs < 1) throw new Error("POINTS_POLL_MS must be a positive integer");
  const maxWindows = cfg.maxWindows ?? DEFAULT_MAX_WINDOWS;
  if (!Number.isInteger(maxWindows) || maxWindows < 1) {
    throw new Error("POINTS_MAX_WINDOWS_PER_PASS must be a positive integer");
  }
  return { ...cfg, escrowAddress: escrow, chainId: CHAIN_ID, logRange, pollMs, maxWindows };
}

/**
 * Pure env loader. Does not open a database or dial a network.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function loadConfig(env = process.env) {
  const chainText = blank(env.CHAIN_ID) ? String(CHAIN_ID) : String(env.CHAIN_ID).trim();
  const chainId = asChainId(chainText);
  if (chainText !== String(CHAIN_ID) || !isAcceptedChain(chainId)) {
    throw new Error(`CHAIN_ID must be ${CHAIN_ID}`);
  }

  const rpcUrl = blank(env.BASE_SEPOLIA_RPC_URL) ? DEFAULT_RPC_URL : String(env.BASE_SEPOLIA_RPC_URL).trim();

  if (env.ESCROW_ADDRESS !== undefined && String(env.ESCROW_ADDRESS).trim() === "") {
    throw new Error("ESCROW_ADDRESS is missing");
  }
  const escrowAddress = blank(env.ESCROW_ADDRESS) ? DEFAULT_ESCROW_ADDRESS : String(env.ESCROW_ADDRESS).trim();

  const dbPath = blank(env.POINTS_DB_PATH)
    ? (blank(env.DATABASE_URL) ? DEFAULT_DB_PATH : String(env.DATABASE_URL).trim())
    : String(env.POINTS_DB_PATH).trim();

  const pollMs = blank(env.POINTS_POLL_MS) ? DEFAULT_POLL_MS : positiveInt(env.POINTS_POLL_MS, "POINTS_POLL_MS");
  const logRange = blank(env.POINTS_LOG_RANGE) ? DEFAULT_LOG_RANGE : positiveInt(env.POINTS_LOG_RANGE, "POINTS_LOG_RANGE");
  const maxWindows = blank(env.POINTS_MAX_WINDOWS_PER_PASS)
    ? DEFAULT_MAX_WINDOWS
    : positiveInt(env.POINTS_MAX_WINDOWS_PER_PASS, "POINTS_MAX_WINDOWS_PER_PASS");

  return assertConfig({ chainId, rpcUrl, escrowAddress, dbPath, pollMs, logRange, maxWindows });
}

/**
 * Pace settings. A missing or invalid value falls back to the default.
 * This does not throw. Defaults stay 200 ms, three retries at 1/2/4 s,
 * a 30 s Retry-After cap, no jitter, a 10 s HTTP timeout, and three poll
 * intervals of health freshness. A gap, cap, timeout, or retry count of 0,
 * or a value above its ceiling, falls back to that default. The ceiling does
 * not raise the 30 s cap. POINTS_MAX_WINDOWS_PER_RUN is unset unless it is a
 * positive integer, and it limits one pass. A User-Agent that is blank or
 * outside the safe character set falls back to the default.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function loadPaceSettings(env = process.env) {
  const minGapMs = blank(env.POINTS_GETLOGS_MIN_GAP_MS)
    ? GETLOGS_MIN_GAP_MS
    : (boundedInt(env.POINTS_GETLOGS_MIN_GAP_MS, 1, GAP_MAX_MS) ?? GETLOGS_MIN_GAP_MS);

  let backoffMs = [...RETRY_BACKOFF_MS];
  if (!blank(env.POINTS_RETRY_BACKOFF_MS)) {
    const parts = String(env.POINTS_RETRY_BACKOFF_MS).split(",").map((part) => part.trim()).filter((part) => part !== "");
    const parsed = parts.map((part) => boundedInt(part, 1, BACKOFF_SLOT_MAX_MS));
    if (parts.length > 0 && parts.length <= BACKOFF_SLOTS_MAX && parsed.every((item) => item != null)) backoffMs = parsed;
  }

  const maxRetries = blank(env.POINTS_MAX_SCAN_RETRIES)
    ? MAX_SCAN_RETRIES
    : (boundedInt(env.POINTS_MAX_SCAN_RETRIES, 1, RETRIES_MAX) ?? MAX_SCAN_RETRIES);
  const maxRetryAfterMs = blank(env.POINTS_MAX_RETRY_AFTER_MS)
    ? MAX_RETRY_AFTER_MS
    : (boundedInt(env.POINTS_MAX_RETRY_AFTER_MS, 1, MAX_RETRY_AFTER_MS) ?? MAX_RETRY_AFTER_MS);
  const gapJitterMs = blank(env.POINTS_GETLOGS_GAP_JITTER_MS)
    ? 0
    : (nonNegativeInt(env.POINTS_GETLOGS_GAP_JITTER_MS) ?? 0);
  const backoffJitterMs = blank(env.POINTS_RETRY_BACKOFF_JITTER_MS)
    ? 0
    : (nonNegativeInt(env.POINTS_RETRY_BACKOFF_JITTER_MS) ?? 0);
  const httpTimeoutMs = blank(env.POINTS_HTTP_TIMEOUT_MS)
    ? DEFAULT_HTTP_TIMEOUT_MS
    : (boundedInt(env.POINTS_HTTP_TIMEOUT_MS, 1, TIMEOUT_MAX_MS) ?? DEFAULT_HTTP_TIMEOUT_MS);
  const freshnessPolls = blank(env.POINTS_HEALTH_FRESHNESS_POLLS)
    ? DEFAULT_HEALTH_FRESHNESS_POLLS
    : (positiveOrNull(env.POINTS_HEALTH_FRESHNESS_POLLS) ?? DEFAULT_HEALTH_FRESHNESS_POLLS);
  const maxWindowsPerRun = blank(env.POINTS_MAX_WINDOWS_PER_RUN)
    ? null
    : positiveOrNull(env.POINTS_MAX_WINDOWS_PER_RUN);
  const rawAgent = blank(env.POINTS_USER_AGENT) ? "" : String(env.POINTS_USER_AGENT).trim();
  const userAgent = USER_AGENT_SAFE.test(rawAgent) ? rawAgent : DEFAULT_USER_AGENT;

  return {
    minGapMs,
    backoffMs,
    maxRetries,
    maxRetryAfterMs,
    gapJitterMs,
    backoffJitterMs,
    httpTimeoutMs,
    freshnessPolls,
    maxWindowsPerRun,
    userAgent,
  };
}

function rangeText(error) {
  const parts = [error.details, error.shortMessage];
  return parts.filter((part) => part != null && part !== "").join(" ").toLowerCase();
}

function textIsRange(text) {
  if (!text) return false;
  if (text.includes("limited to")) return true;
  if (text.includes("block range")) return true;
  if (text.includes("too large")) return true;
  if (text.includes("too many results") || text.includes("too many logs")) return true;
  if (text.includes("query returned more")) return true;
  if (text.includes("exceed")) return true;
  if (text.includes("log limit")) return true;
  if (text.includes("response size") && text.includes("log")) return true;
  if (text.includes("more than") && (text.includes("result") || text.includes("log"))) return true;
  return false;
}

/**
 * Provider block-range limit. HTTP 429 is never a range error, including when
 * the provider text contains "exceed". Rate-limit text on details and
 * shortMessage is not a range error either. HTTP 413 and JSON-RPC -32614 still are.
 * Text is read only from details and shortMessage. The full message is ignored:
 * viem puts the hex request body there, and a block number can contain "413".
 */
export function isRangeError(error) {
  if (!error || typeof error !== "object") return false;
  const status = numericCode(error.status ?? error.statusCode);
  if (status === 429) return false;
  const code = numericCode(error.code);
  if (code === -32614) return true;
  if (status === 413 || code === 413) return true;
  const text = rangeText(error);
  if (textIsHeadLag(text)) return false;
  if (textIsRateLimit(text)) return false;
  if (code === -32005 || code === -32602) return textIsRange(text);
  return textIsRange(text);
}

/**
 * N from "limited to a N range", read from details and shortMessage only.
 * The provider allows toBlock - fromBlock <= N, so a window of N inclusive
 * blocks (difference N - 1) is inside that limit.
 * @returns {number | null}
 */
export function rangeLimit(error) {
  if (!error || typeof error !== "object") return null;
  const text = [error.details, error.shortMessage].filter((part) => part != null && part !== "").join(" ");
  const match = /limited to a (\d+) range/i.exec(text);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function nextRangeWindow(window, error, max) {
  const limit = rangeLimit(error);
  if (limit != null) {
    const clamped = Math.min(max, Math.max(1, limit));
    if (clamped < window) return clamped;
  }
  return Math.max(1, Math.floor(window / 2));
}

export function emptyCode(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return text === "" || text === "0x" || /^0x0+$/.test(text);
}

/**
 * Short code stored in status and returned by /health. Never the provider text.
 * @param {unknown} error
 */
export function errorCode(error) {
  if (!error || typeof error !== "object") return "rpc_error";
  if (isRangeError(error)) return "range_error";
  if (typeof error.scanReason === "string" && PACE_REASONS.has(error.scanReason)) return error.scanReason;
  const paced = scanErrorClass(error);
  if (paced) return paced;
  if (error instanceof PointsError || error.name === "PointsError") return "ledger_error";
  const name = String(error.name ?? "");
  if (/sqlite/i.test(name) || (typeof error.code === "string" && /SQLITE/i.test(error.code))) return "ledger_error";
  const message = String(error.message ?? "");
  if (
    message.startsWith("CHAIN_ID must")
    || message.startsWith("ESCROW_ADDRESS")
    || message.startsWith("POINTS_")
    || message.startsWith("PORT must")
    || message.startsWith("RPC chain id")
    || message.startsWith("RPC getCode")
    || message.includes("contract code is empty")
  ) return "config_error";
  return "rpc_error";
}

function keyLikeSegment(segment) {
  return /[A-Za-z]/.test(segment) && /\d/.test(segment);
}

/** Replace RPC URLs, websocket URLs, and key-like path segments before a line is logged. */
export function redact(text, rpcUrl) {
  let out = String(text ?? "");
  if (rpcUrl) out = out.split(String(rpcUrl)).join("[redacted-url]");
  out = out.replace(URL_PATTERN, "[redacted-url]");
  out = out.replace(ENCODED_URL_PATTERN, "[redacted-url]");
  out = out.replace(QUERY_SECRET_PATTERN, "$1[redacted]");
  return out.replace(KEY_SEGMENT_PATTERN, (match, segment) => (keyLikeSegment(segment) ? "/[redacted]" : match));
}

function logFailure(error, rpcUrl) {
  const code = errorCode(error);
  const name = error && typeof error === "object" && error.name ? String(error.name) : "Error";
  const short = error && typeof error === "object" && error.shortMessage != null ? String(error.shortMessage) : "";
  console.error(redact(`${code} ${name} ${short}`.trim(), rpcUrl));
}

/**
 * @param {{ lastPassAt: number | null, pollMs: number, now: number, behind?: number }} status
 */
export function healthDecision(status) {
  const polls = Number.isInteger(status.freshnessPolls) && status.freshnessPolls >= 1
    ? status.freshnessPolls
    : DEFAULT_HEALTH_FRESHNESS_POLLS;
  const fresh = status.lastPassAt != null && status.now - status.lastPassAt <= polls * status.pollMs;
  const behind = Number.isSafeInteger(status.behind) ? Math.max(0, status.behind) : 0;
  return { ok: fresh, statusCode: fresh ? 200 : 503, behind };
}

function blocksBehind(head, cursor) {
  if (!Number.isSafeInteger(head)) return 0;
  if (cursor == null) {
    if (head < ESCROW_START_BLOCK) return 0;
    return head - ESCROW_START_BLOCK + 1;
  }
  return Math.max(0, head - cursor);
}

/**
 * Keep HTTP 429 and 5xx status plus Retry-After on the error.
 * viem otherwise turns a JSON-RPC body into an RPC error and drops the header.
 * HTTP 413 is left on viem's path so a range code still surfaces.
 */
function withUserAgent(init, userAgent) {
  const headers = new Headers(init?.headers ?? undefined);
  if (userAgent) headers.set("user-agent", userAgent);
  return { ...(init ?? {}), headers };
}

async function pointsFetch(url, init, userAgent = DEFAULT_USER_AGENT) {
  const response = await fetch(url, withUserAgent(init, userAgent));
  const status = response.status;
  if (status !== 429 && (status < 500 || status > 599)) return response;
  const text = await response.text();
  let details = response.statusText || "";
  if (text) {
    try {
      const parsed = JSON.parse(text);
      const message = parsed?.error?.message ?? parsed?.message;
      if (typeof message === "string" && message.trim() !== "") details = message;
    } catch {
      details = text.slice(0, 200);
    }
  }
  throw new HttpRequestError({
    details,
    headers: response.headers,
    status,
    url: String(url),
  });
}

/** viem retries stay off. The scan pacer is the only retry layer. */
export function createPointsHttpTransport(rpcUrl, { timeout = DEFAULT_HTTP_TIMEOUT_MS, userAgent = DEFAULT_USER_AGENT } = {}) {
  return http(rpcUrl, {
    retryCount: 0,
    timeout,
    fetchFn: (url, init) => pointsFetch(url, init, userAgent),
  });
}

export function createDefaultRpc(rpcUrl, transportOptions) {
  const client = createPublicClient({
    chain: baseSepolia,
    transport: createPointsHttpTransport(rpcUrl, transportOptions),
  });
  return {
    chainId: () => client.getChainId(),
    finalizedBlockNumber: async () => {
      const block = await client.getBlock({ blockTag: "finalized" });
      return block.number;
    },
    getCode: ({ address }) => client.getCode({ address }),
    getLogs: (args) => client.getLogs({
      address: args.address,
      fromBlock: BigInt(args.fromBlock),
      toBlock: BigInt(args.toBlock),
    }),
  };
}

function listenHealth(port, status) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0];
      if (path === "/health" || path === "/health/") {
        const decision = healthDecision({
          lastPassAt: status.lastPassAt,
          pollMs: status.pollMs,
          freshnessPolls: status.freshnessPolls,
          now: status.now(),
          behind: status.behind,
        });
        const body = { ok: decision.ok, chainId: status.chainId };
        if (decision.ok && decision.behind > 0) body.behind = decision.behind;
        if (!decision.ok && status.lastError) body.error = status.lastError;
        else if (decision.ok && status.earlyReason) body.error = status.earlyReason;
        res.writeHead(decision.statusCode, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    });
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      const address = server.address();
      const bound = typeof address === "object" && address ? address.port : port;
      resolve({
        port: bound,
        url: `http://127.0.0.1:${bound}/health`,
        close: async () => {
          await new Promise((done, fail) => server.close((error) => (error ? fail(error) : done())));
        },
      });
    });
  });
}

async function pacedCall(pacer, fn) {
  const result = await pacer.run(fn);
  if (result.ok) return result.value;
  const error = result.error instanceof Error ? result.error : new Error("rpc failed");
  error.scanReason = result.reason;
  throw error;
}

async function assertContractCode(rpc, address, label, pacer) {
  if (typeof rpc.getCode !== "function") throw new Error(`RPC getCode is required for ${label}`);
  const code = await pacedCall(pacer, () => rpc.getCode({ address }));
  if (emptyCode(code)) throw new Error(`${label} contract code is empty`);
}

/**
 * One ingest pass, then an optional poll loop.
 * Pass `rpc` to avoid dialing. Pass `once: true` to return after a single pass
 * and to surface a scan failure. A 429, 5xx, or network failure on getLogs
 * does not reject the pass: after the bounded retries the pass returns at the
 * last committed window and the timer continues. Other scan failures still
 * reject when `once` is set. Without `once`, a thrown scan failure stays in the
 * process: /health stays up and the timer retries. Chain id and contract code
 * use the same pacer. A retryable failure there that does not recover still
 * rejects. A retryable failure on the finalized head ends the pass instead.
 * Config failures still reject.
 * `paceNow` times the gap and defaults to `performance.now`. `wallNow` defaults
 * to `Date.now` and is used only to read an HTTP-date Retry-After and to carry
 * a Retry-After that was longer than the cap. `sleep` defaults to a real timer.
 * POINTS_MAX_WINDOWS_PER_RUN limits windows inside one pass. The next pass
 * continues. A reported finalized head behind the stored head scans nothing.
 * @param {{ rpc?: object, env?: NodeJS.ProcessEnv, config?: object, once?: boolean, serve?: boolean, port?: number, now?: () => number, paceNow?: () => number, wallNow?: () => number, sleep?: (ms: number) => Promise<void>, onListening?: Function, onIndexer?: Function }} [options]
 */
export async function start(options = {}) {
  const cfg = assertConfig(options.config ?? loadConfig(options.env ?? process.env));
  const paceEnv = options.env ?? (options.config ? {} : process.env);
  const pace = loadPaceSettings(paceEnv);
  const now = options.now ?? (() => performance.now());
  const paceNow = options.paceNow ?? (() => performance.now());
  const wallNow = options.wallNow ?? (() => Date.now());
  const sleep = options.sleep ?? sleepMs;
  const pacer = createScanPacer({
    now: paceNow,
    wallNow,
    sleep,
    minGapMs: pace.minGapMs,
    gapJitterMs: pace.gapJitterMs,
    backoffMs: pace.backoffMs,
    backoffJitterMs: pace.backoffJitterMs,
    maxRetries: pace.maxRetries,
    maxRetryAfterMs: pace.maxRetryAfterMs,
    classify(error) {
      if (isRangeError(error)) return null;
      return scanErrorClass(error);
    },
  });
  const rpc = options.rpc ?? createDefaultRpc(cfg.rpcUrl, {
    timeout: pace.httpTimeoutMs,
    userAgent: pace.userAgent,
  });
  const reportedChain = asChainId(await pacedCall(pacer, () => rpc.chainId()));
  if (!isAcceptedChain(reportedChain)) {
    throw new Error(`RPC chain id is ${String(reportedChain)}, expected ${CHAIN_ID}`);
  }
  await assertContractCode(rpc, cfg.escrowAddress, "escrow", pacer);
  await assertContractCode(rpc, PANEL, "panel", pacer);

  if (cfg.dbPath !== ":memory:") mkdirSync(dirname(cfg.dbPath), { recursive: true });

  let indexer = null;
  let timer = null;
  let closing = null;
  let healthUrl = null;
  let stopped = false;
  let inFlight = false;
  let skippedTicks = 0;
  let learnedWindow = cfg.logRange;
  let dirty = false;
  let carryUntil = null;
  const status = {
    chainId: cfg.chainId,
    pollMs: cfg.pollMs,
    freshnessPolls: pace.freshnessPolls,
    lastPassAt: null,
    lastError: null,
    earlyReason: null,
    behind: 0,
    now,
  };

  const runOnce = async () => {
    if (carryUntil != null) {
      const remain = carryUntil - wallNow();
      carryUntil = null;
      if (remain > 0) await sleep(remain);
    }
    const headRead = await pacer.run(() => rpc.finalizedBlockNumber());
    if (!headRead.ok) {
      if (headRead.deferUntil != null) carryUntil = headRead.deferUntil;
      const reason = headRead.reason;
      status.earlyReason = reason;
      status.lastError = reason;
      console.error(`${reason} pass_ended_early`);
      return {
        ok: true,
        endedEarly: true,
        reason,
        inserted: 0,
        rebuilds: 0,
        ranges: [],
        skipped: false,
        scannedThrough: indexer ? indexer.lastScannedBlock() : null,
        behind: status.behind,
      };
    }
    const reported = asChainId(headRead.value);
    if (!Number.isSafeInteger(reported) || reported < 0) throw new Error("RPC finalized block is not a safe integer");
    if (!indexer) {
      indexer = openIndexer({ path: cfg.dbPath, finalizedBlock: reported, chainId: cfg.chainId });
      if (typeof options.onIndexer === "function") options.onIndexer(indexer);
    }
    if (reported < indexer.finalizedBlock) {
      status.earlyReason = "head_behind";
      status.lastError = "head_behind";
      status.behind = blocksBehind(indexer.finalizedBlock, indexer.lastScannedBlock());
      console.error("head_behind");
      return {
        ok: true,
        endedEarly: true,
        reason: "head_behind",
        inserted: 0,
        rebuilds: 0,
        ranges: [],
        skipped: false,
        scannedThrough: indexer.lastScannedBlock(),
        behind: status.behind,
      };
    }
    const head = reported;
    const cursor = indexer.lastScannedBlock();
    let from = cursor == null ? ESCROW_START_BLOCK : Math.max(ESCROW_START_BLOCK, cursor + 1);
    let window = learnedWindow;
    let inserted = 0;
    let committedWindows = 0;
    let windowsThisPass = 0;
    let earlyReason = null;
    const ranges = [];
    status.behind = blocksBehind(head, cursor);
    while (
      from <= head
      && committedWindows < cfg.maxWindows
      && (pace.maxWindowsPerRun == null || windowsThisPass < pace.maxWindowsPerRun)
    ) {
      const to = Math.min(head, from + window - 1);
      let logs;
      try {
        const scanned = await pacer.run(() => rpc.getLogs({
          fromBlock: from,
          toBlock: to,
          address: [cfg.escrowAddress, PANEL],
        }));
        if (!scanned.ok) {
          if (scanned.deferUntil != null) carryUntil = scanned.deferUntil;
          earlyReason = scanned.reason;
          break;
        }
        logs = scanned.value;
      } catch (error) {
        if (isRangeError(error) && window > 1) {
          window = nextRangeWindow(window, error, cfg.logRange);
          learnedWindow = window;
          continue;
        }
        throw error;
      }
      dirty = true;
      const committed = indexer.commitScanWindow(Array.isArray(logs) ? logs : [], to, { chainId: cfg.chainId });
      inserted += committed.inserted;
      committedWindows += 1;
      windowsThisPass += 1;
      ranges.push({ fromBlock: from, toBlock: to });
      from = to + 1;
      learnedWindow = Math.min(cfg.logRange, window * 2);
      window = learnedWindow;
      status.lastPassAt = now();
      status.lastError = null;
      status.behind = blocksBehind(head, to);
    }
    if (
      earlyReason == null
      && pace.maxWindowsPerRun != null
      && windowsThisPass >= pace.maxWindowsPerRun
      && from <= head
    ) {
      earlyReason = "run_cap";
    }
    const headResult = indexer.setFinalizedBlock(head, { rebuild: false });
    let rebuilds = 0;
    if (dirty || inserted > 0 || headResult.moved) {
      indexer.rebuild();
      dirty = false;
      rebuilds = 1;
    }
    status.behind = blocksBehind(head, indexer.lastScannedBlock());
    const scannedThrough = indexer.lastScannedBlock();
    if (earlyReason) {
      status.earlyReason = earlyReason;
      status.lastError = earlyReason;
      console.error(`${earlyReason} pass_ended_early`);
      return {
        ok: true,
        endedEarly: true,
        reason: earlyReason,
        inserted,
        rebuilds,
        ranges,
        skipped: false,
        scannedThrough,
        behind: status.behind,
      };
    }
    status.earlyReason = null;
    status.lastPassAt = now();
    status.lastError = null;
    return {
      ok: true,
      endedEarly: false,
      inserted,
      rebuilds,
      ranges,
      skipped: false,
      scannedThrough,
      behind: status.behind,
    };
  };

  const pass = async () => {
    if (stopped) return { skipped: true, stopped: true, skippedTicks };
    if (inFlight) {
      skippedTicks += 1;
      return { skipped: true, skippedTicks };
    }
    inFlight = true;
    try {
      return await runOnce();
    } catch (error) {
      status.earlyReason = null;
      status.lastError = errorCode(error);
      throw error;
    } finally {
      inFlight = false;
    }
  };

  if (options.serve) {
    const port = options.port ?? (blank(process.env.PORT) ? 8080 : positiveInt(process.env.PORT, "PORT"));
    const health = await listenHealth(port, status);
    closing = health.close;
    healthUrl = health.url;
    if (typeof options.onListening === "function") options.onListening(health);
  }

  let ingested;
  if (options.once) {
    ingested = await pass();
  } else {
    try {
      ingested = await pass();
    } catch (error) {
      logFailure(error, cfg.rpcUrl);
      ingested = { ok: false, error: status.lastError };
    }
    const loop = () => {
      timer = setTimeout(() => {
        pass()
          .catch((error) => {
            logFailure(error, cfg.rpcUrl);
          })
          .finally(() => {
            if (!stopped) loop();
          });
      }, cfg.pollMs);
    };
    loop();
  }

  return {
    indexer,
    ingested,
    healthUrl,
    pass,
    get skippedTicks() {
      return skippedTicks;
    },
    config: {
      chainId: cfg.chainId,
      escrowAddress: cfg.escrowAddress,
      dbPath: cfg.dbPath,
      pollMs: cfg.pollMs,
      logRange: cfg.logRange,
      maxWindows: cfg.maxWindows,
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      if (closing) await closing();
      indexer?.close();
    },
  };
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (invokedDirectly()) {
  start({ serve: true }).catch((error) => {
    const rpcUrl = blank(process.env.BASE_SEPOLIA_RPC_URL) ? DEFAULT_RPC_URL : String(process.env.BASE_SEPOLIA_RPC_URL).trim();
    logFailure(error, rpcUrl);
    process.exit(1);
  });
}
