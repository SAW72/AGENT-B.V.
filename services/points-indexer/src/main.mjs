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
  if (!ADDRESS.test(escrowAddress)) throw new Error("ESCROW_ADDRESS is malformed");
  if (escrowAddress.toLowerCase() === ZERO_ADDRESS) throw new Error("ESCROW_ADDRESS is the zero address");
  if (escrowAddress.toLowerCase() !== ESCROW) {
    throw new Error(`ESCROW_ADDRESS must be ${DEFAULT_ESCROW_ADDRESS}`);
  }

  const dbPath = blank(env.POINTS_DB_PATH)
    ? (blank(env.DATABASE_URL) ? DEFAULT_DB_PATH : String(env.DATABASE_URL).trim())
    : String(env.POINTS_DB_PATH).trim();

  let pollMs = DEFAULT_POLL_MS;
  if (!blank(env.POINTS_POLL_MS)) {
    const text = String(env.POINTS_POLL_MS).trim();
    if (!/^[1-9][0-9]*$/.test(text)) throw new Error("POINTS_POLL_MS must be a positive integer");
    pollMs = Number(text);
  }

  return { chainId, rpcUrl, escrowAddress, dbPath, pollMs };
}

function createDefaultRpc(rpcUrl) {
  const client = createPublicClient({
    chain: baseSepolia,
    transport: http(rpcUrl),
  });
  return {
    chainId: () => client.getChainId(),
    finalizedBlockNumber: () => client.getBlockNumber({ blockTag: "finalized" }),
    getLogs: (args) => client.getLogs({
      address: args.address,
      fromBlock: BigInt(args.fromBlock),
      toBlock: BigInt(args.toBlock),
    }),
  };
}

function listenHealth(chainId) {
  const portText = blank(process.env.PORT) ? "8080" : String(process.env.PORT).trim();
  if (!/^[0-9]+$/.test(portText)) throw new Error("PORT must be an integer");
  const port = Number(portText);
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0];
      if (path === "/health" || path === "/health/") {
        const body = JSON.stringify({ ok: true, chainId });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    });
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      resolve(async () => {
        await new Promise((done, fail) => server.close((error) => (error ? fail(error) : done())));
      });
    });
  });
}

/**
 * One ingest pass, then an optional poll loop.
 * Pass `rpc` to avoid dialing. Pass `once: true` to return after a single pass.
 * @param {{ rpc?: object, env?: NodeJS.ProcessEnv, config?: ReturnType<typeof loadConfig>, once?: boolean, serve?: boolean }} [options]
 */
export async function start(options = {}) {
  const cfg = options.config ?? loadConfig(options.env ?? process.env);
  if (!isAcceptedChain(cfg.chainId)) throw new Error(`CHAIN_ID must be ${CHAIN_ID}`);

  const rpc = options.rpc ?? createDefaultRpc(cfg.rpcUrl);
  const reported = asChainId(await rpc.chainId());
  if (!isAcceptedChain(reported)) {
    throw new Error(`RPC chain id is ${String(reported)}, expected ${CHAIN_ID}`);
  }

  if (cfg.dbPath !== ":memory:") mkdirSync(dirname(cfg.dbPath), { recursive: true });

  let indexer = null;
  let timer = null;
  let closing = null;
  let stopped = false;

  const pass = async () => {
    const head = asChainId(await rpc.finalizedBlockNumber());
    if (!Number.isInteger(head) || head < 0) throw new Error("RPC finalized block is not a safe integer");
    const logs = await rpc.getLogs({
      fromBlock: ESCROW_START_BLOCK,
      toBlock: head,
      address: [cfg.escrowAddress, PANEL],
    });
    if (!indexer) indexer = openIndexer({ path: cfg.dbPath, finalizedBlock: head, chainId: cfg.chainId });
    else if (head !== indexer.finalizedBlock) indexer.setFinalizedBlock(head);
    return indexer.ingestLogs(Array.isArray(logs) ? logs : [], { chainId: cfg.chainId });
  };

  if (options.serve) closing = await listenHealth(cfg.chainId);
  const ingested = await pass();
  if (!options.once) {
    timer = setInterval(() => {
      pass().catch((error) => {
        console.error(error instanceof Error ? error.message : "poll failed");
      });
    }, cfg.pollMs);
  }

  return {
    indexer,
    ingested,
    config: {
      chainId: cfg.chainId,
      escrowAddress: cfg.escrowAddress,
      dbPath: cfg.dbPath,
      pollMs: cfg.pollMs,
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
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
