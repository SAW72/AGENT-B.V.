import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { CHAIN_ID, ESCROW, ESCROW_START_BLOCK, PANEL, isAcceptedChain } from "./constants.mjs";
import { openIndexer } from "./indexer.mjs";

export const DEFAULT_RPC_URL = "https://sepolia.base.org";
export const DEFAULT_ESCROW_ADDRESS = "0x3d660502D75f1e97b08c110255921b437A3C4C42";
export const DEFAULT_POLL_MS = 15_000;
export const DEFAULT_LOG_RANGE = 2_000;
export const DEFAULT_DB_PATH = "points-indexer.sqlite";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

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
  return { ...cfg, escrowAddress: escrow, chainId: CHAIN_ID, logRange, pollMs };
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

  return assertConfig({ chainId, rpcUrl, escrowAddress, dbPath, pollMs, logRange });
}

/** A 413, an oversized block range, or a too-many-results response. */
export function isRangeError(error) {
  if (!error || typeof error !== "object") return false;
  const status = error.status ?? error.statusCode;
  if (status === 413 || status === "413") return true;
  if (error.code === 413 || error.code === "413") return true;
  const parts = [error.message, error.shortMessage, error.details, error.cause?.message, error.cause?.details];
  const text = parts.filter((part) => part != null && part !== "").join(" ").toLowerCase();
  if (text.includes("413") || text.includes("payload too large")) return true;
  if (text.includes("too many results") || text.includes("too many logs")) return true;
  if (text.includes("query returned more")) return true;
  if (text.includes("block range") || text.includes("exceeds max block") || text.includes("log limit")) return true;
  if (text.includes("response size") && text.includes("log")) return true;
  if (text.includes("more than") && (text.includes("result") || text.includes("log"))) return true;
  return false;
}

export function emptyCode(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return text === "" || text === "0x" || /^0x0+$/.test(text);
}

/**
 * @param {{ lastPassAt: number | null, pollMs: number, now: number }} status
 */
export function healthDecision(status) {
  const fresh = status.lastPassAt != null && status.now - status.lastPassAt <= 3 * status.pollMs;
  return { ok: fresh, statusCode: fresh ? 200 : 503 };
}

function createDefaultRpc(rpcUrl) {
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

function listenHealth(port, status) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0];
      if (path === "/health" || path === "/health/") {
        const decision = healthDecision({
          lastPassAt: status.lastPassAt,
          pollMs: status.pollMs,
          now: status.now(),
        });
        const body = { ok: decision.ok, chainId: status.chainId };
        if (!decision.ok && status.lastError) body.error = status.lastError;
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

async function assertContractCode(rpc, address, label) {
  if (typeof rpc.getCode !== "function") throw new Error(`RPC getCode is required for ${label}`);
  const code = await rpc.getCode({ address });
  if (emptyCode(code)) throw new Error(`${label} contract code is empty`);
}

/**
 * One ingest pass, then an optional poll loop.
 * Pass `rpc` to avoid dialing. Pass `once: true` to return after a single pass.
 * @param {{ rpc?: object, env?: NodeJS.ProcessEnv, config?: object, once?: boolean, serve?: boolean, port?: number, now?: () => number, onListening?: Function }} [options]
 */
export async function start(options = {}) {
  const cfg = assertConfig(options.config ?? loadConfig(options.env ?? process.env));
  const now = options.now ?? (() => Date.now());
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
  const status = {
    chainId: cfg.chainId,
    pollMs: cfg.pollMs,
    lastPassAt: null,
    lastError: null,
    now,
  };

  const runOnce = async () => {
    const reported = asChainId(await rpc.finalizedBlockNumber());
    if (!Number.isSafeInteger(reported) || reported < 0) throw new Error("RPC finalized block is not a safe integer");
    if (!indexer) {
      indexer = openIndexer({ path: cfg.dbPath, finalizedBlock: reported, chainId: cfg.chainId });
    }
    const head = Math.max(indexer.finalizedBlock, reported);
    const cursor = indexer.lastScannedBlock();
    let from = cursor == null ? ESCROW_START_BLOCK : Math.max(ESCROW_START_BLOCK, cursor + 1);
    let window = cfg.logRange;
    let inserted = 0;
    const ranges = [];
    while (from <= head) {
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
          window = Math.max(1, Math.floor(window / 2));
          continue;
        }
        throw error;
      }
      const committed = indexer.commitScanWindow(Array.isArray(logs) ? logs : [], to, { chainId: cfg.chainId });
      inserted += committed.inserted;
      ranges.push({ fromBlock: from, toBlock: to });
      from = to + 1;
    }
    const headResult = indexer.setFinalizedBlock(head, { rebuild: false });
    let rebuilds = 0;
    if (inserted > 0 || headResult.moved) {
      indexer.rebuild();
      rebuilds = 1;
    }
    return {
      ok: true,
      inserted,
      rebuilds,
      ranges,
      skipped: false,
      scannedThrough: indexer.lastScannedBlock(),
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
      const result = await runOnce();
      status.lastPassAt = now();
      status.lastError = null;
      return result;
    } catch (error) {
      status.lastError = error instanceof Error ? error.message : "poll failed";
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

  const ingested = await pass();
  if (!options.once) {
    const loop = () => {
      timer = setTimeout(() => {
        pass()
          .catch((error) => {
            console.error(error instanceof Error ? error.message : "poll failed");
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
    console.error(error instanceof Error ? error.message : "startup failed");
    process.exit(1);
  });
}
