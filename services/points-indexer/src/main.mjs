import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { CHAIN_ID, ESCROW, ESCROW_START_BLOCK, PANEL, isAcceptedChain } from "./constants.mjs";
import { PointsError } from "./hex.mjs";
import { openIndexer } from "./indexer.mjs";

export const DEFAULT_RPC_URL = "https://sepolia.base.org";
export const DEFAULT_ESCROW_ADDRESS = "0x3d660502D75f1e97b08c110255921b437A3C4C42";
export const DEFAULT_POLL_MS = 15_000;
export const DEFAULT_LOG_RANGE = 200;
export const DEFAULT_MAX_WINDOWS = 500;
export const DEFAULT_DB_PATH = "points-indexer.sqlite";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const URL_PATTERN = /https?:\/\/\S+/gi;

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
 * POINTS_ENABLED is off unless the value is 1, true, on, or yes.
 * Checked on each request so the read module stays unloaded while this is off.
 * @param {{ POINTS_ENABLED?: unknown } | undefined} env
 */
function pointsGate(env) {
  const raw = env?.POINTS_ENABLED;
  if (raw == null || String(raw).trim() === "") return false;
  const text = String(raw).trim().toLowerCase();
  return text === "1" || text === "true" || text === "on" || text === "yes";
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
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

  const cfg = assertConfig({ chainId, rpcUrl, escrowAddress, dbPath, pollMs, logRange, maxWindows });
  cfg.pointsEnabled = pointsGate(env);
  return cfg;
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
 * Provider block-range limit. Codes and HTTP status are checked before text.
 * Text is read only from details and shortMessage. The full message is ignored:
 * viem puts the hex request body there, and a block number can contain "413".
 */
export function isRangeError(error) {
  if (!error || typeof error !== "object") return false;
  const code = numericCode(error.code);
  if (code === -32614) return true;
  const status = numericCode(error.status ?? error.statusCode);
  if (status === 413 || code === 413) return true;
  const text = rangeText(error);
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

/** Replace the configured RPC URL and any http(s) URL before a line is logged. */
export function redact(text, rpcUrl) {
  let out = String(text ?? "");
  if (rpcUrl) out = out.split(String(rpcUrl)).join("[redacted-url]");
  return out.replace(URL_PATTERN, "[redacted-url]");
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
  const fresh = status.lastPassAt != null && status.now - status.lastPassAt <= 3 * status.pollMs;
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

export function createDefaultRpc(rpcUrl) {
  const client = createPublicClient({
    chain: baseSepolia,
    transport: http(rpcUrl),
  });
  return {
    chainId: () => client.getChainId(),
    finalizedBlockNumber: () => client.getBlockNumber({ blockTag: "finalized" }),
    getCode: ({ address }) => client.getCode({ address }),
    getLogs: (args) => client.getLogs({
      address: args.address,
      fromBlock: BigInt(args.fromBlock),
      toBlock: BigInt(args.toBlock),
    }),
  };
}

function listenHealth(port, status, onPoints) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0];
      if (path === "/health" || path === "/health/") {
        const decision = healthDecision({
          lastPassAt: status.lastPassAt,
          pollMs: status.pollMs,
          now: status.now(),
          behind: status.behind,
        });
        const body = { ok: decision.ok, chainId: status.chainId };
        if (decision.ok && decision.behind > 0) body.behind = decision.behind;
        if (!decision.ok && status.lastError) body.error = status.lastError;
        res.writeHead(decision.statusCode, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
        return;
      }
      if (path === "/v1/points" || path.startsWith("/v1/points/")) {
        Promise.resolve()
          .then(() => onPoints(req, res))
          .catch(() => {
            if (res.headersSent) return;
            try {
              writeJson(res, 500, { ok: false, error: "internal" });
            } catch {
              // The request callback must not throw.
            }
          });
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

async function assertContractCode(rpc, address, label) {
  if (typeof rpc.getCode !== "function") throw new Error(`RPC getCode is required for ${label}`);
  const code = await rpc.getCode({ address });
  if (emptyCode(code)) throw new Error(`${label} contract code is empty`);
}

/**
 * One ingest pass, then an optional poll loop.
 * Pass `rpc` to avoid dialing. Pass `once: true` to return after a single pass
 * and to surface a scan failure. Without `once`, a scan failure stays in the
 * process: /health stays up and the timer retries. Chain id, contract code,
 * and config failures still reject.
 * @param {{ rpc?: object, env?: NodeJS.ProcessEnv, config?: object, once?: boolean, serve?: boolean, port?: number, now?: () => number, onListening?: Function, onIndexer?: Function }} [options]
 */
export async function start(options = {}) {
  const cfg = assertConfig(options.config ?? loadConfig(options.env ?? process.env));
  const now = options.now ?? (() => performance.now());
  const rpc = options.rpc ?? createDefaultRpc(cfg.rpcUrl);
  const reportedChain = asChainId(await rpc.chainId());
  if (!isAcceptedChain(reportedChain)) {
    throw new Error(`RPC chain id is ${String(reportedChain)}, expected ${CHAIN_ID}`);
  }
  await assertContractCode(rpc, cfg.escrowAddress, "escrow");
  await assertContractCode(rpc, PANEL, "panel");

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
  const status = {
    chainId: cfg.chainId,
    pollMs: cfg.pollMs,
    lastPassAt: null,
    lastError: null,
    behind: 0,
    now,
  };

  const runOnce = async () => {
    const reported = asChainId(await rpc.finalizedBlockNumber());
    if (!Number.isSafeInteger(reported) || reported < 0) throw new Error("RPC finalized block is not a safe integer");
    if (!indexer) {
      indexer = openIndexer({ path: cfg.dbPath, finalizedBlock: reported, chainId: cfg.chainId });
      if (typeof options.onIndexer === "function") options.onIndexer(indexer);
    }
    const head = Math.max(indexer.finalizedBlock, reported);
    const cursor = indexer.lastScannedBlock();
    let from = cursor == null ? ESCROW_START_BLOCK : Math.max(ESCROW_START_BLOCK, cursor + 1);
    let window = learnedWindow;
    let inserted = 0;
    let committedWindows = 0;
    const ranges = [];
    status.behind = blocksBehind(head, cursor);
    while (from <= head && committedWindows < cfg.maxWindows) {
      const to = Math.min(head, from + window - 1);
      let logs;
      try {
        logs = await rpc.getLogs({
          fromBlock: from,
          toBlock: to,
          address: [cfg.escrowAddress, PANEL],
        });
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
      ranges.push({ fromBlock: from, toBlock: to });
      from = to + 1;
      learnedWindow = Math.min(cfg.logRange, window * 2);
      window = learnedWindow;
      status.lastPassAt = now();
      status.lastError = null;
      status.behind = blocksBehind(head, to);
    }
    const headResult = indexer.setFinalizedBlock(head, { rebuild: false });
    let rebuilds = 0;
    if (dirty || inserted > 0 || headResult.moved) {
      indexer.rebuild();
      dirty = false;
      rebuilds = 1;
    }
    status.lastPassAt = now();
    status.lastError = null;
    status.behind = blocksBehind(head, indexer.lastScannedBlock());
    return {
      ok: true,
      inserted,
      rebuilds,
      ranges,
      skipped: false,
      scannedThrough: indexer.lastScannedBlock(),
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
      status.lastError = errorCode(error);
      throw error;
    } finally {
      inFlight = false;
    }
  };

  let readApi = null;
  let readApiLoading = null;
  const env = options.env ?? process.env;

  async function handlePoints(req, res) {
    if (!pointsGate(env)) {
      writeJson(res, 503, { ok: false, error: "points_disabled" });
      return;
    }
    if (!readApi) {
      if (!readApiLoading) {
        readApiLoading = import("./readApi.mjs").then((mod) => {
          readApi = mod.createReadApi({
            store: {
              db: () => indexer?.db ?? null,
              lastScannedBlock: () => (indexer ? indexer.lastScannedBlock() : null),
              finalizedBlock: () => (indexer ? indexer.finalizedBlock : null),
              passCompleted: () => status.lastPassAt != null,
            },
            config: mod.readSettings(env),
            now: () => Date.now(),
            enabled: () => mod.pointsEnabled(env),
          });
          return readApi;
        }).catch((error) => {
          readApiLoading = null;
          throw error;
        });
      }
      await readApiLoading;
    }
    readApi(req, res);
  }

  if (options.serve) {
    const port = options.port ?? (blank(process.env.PORT) ? 8080 : positiveInt(process.env.PORT, "PORT"));
    const health = await listenHealth(port, status, handlePoints);
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
      if (readApiLoading) {
        try {
          const api = await readApiLoading;
          api?.close();
        } catch {
          // The module never finished loading.
        }
      }
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
