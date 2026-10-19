/**
 * Base Sepolia escrow broadcast. This is the only module that signs or sends.
 * Chain ids 1 and 8453 are refused before and after the RPC chain check.
 * RELAYER_PRIVATE_KEY stays in this closure. It is never logged or returned.
 */

import { createWalletClient, custom, http, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { BASE_SEPOLIA_CHAIN_ID, BOOKED_SEPOLIA_ESCROW, httpError, loadAbuseLimits } from "./config.mjs";
import { isTransientClaimError, withClaimRetry } from "./retry.mjs";
import { extractRevertData, revertDataFrom } from "./revertData.mjs";

if (baseSepolia.id !== BASE_SEPOLIA_CHAIN_ID) {
  throw new Error("base_sepolia_chain_drift");
}

const DEFAULT_RPC = "https://sepolia.base.org";

/** Preparation calls only. eth_sendRawTransaction is checked separately. */
const PREP_METHODS = new Set([
  "eth_fillTransaction",
  "eth_estimateGas",
  "eth_call",
  "eth_getTransactionCount",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getBalance",
  "eth_chainId",
]);

function redact(text, key) {
  let out = String(text || "");
  const raw = String(key || "");
  if (!raw) return out;
  out = out.split(raw).join("[redacted]");
  const bare = raw.startsWith("0x") || raw.startsWith("0X") ? raw.slice(2) : raw;
  if (bare) out = out.split(bare).join("[redacted]");
  return out;
}

function parseChainId(value) {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  const text = String(value ?? "").trim();
  if (/^0x[0-9a-fA-F]+$/.test(text)) return Number(text);
  if (/^[0-9]+$/.test(text)) return Number(text);
  throw httpError(400, "wrong_chain");
}

function assertRemoteChain(chainId) {
  if (chainId === 1 || chainId === 8453) throw httpError(400, "mainnet_refused", { chainId });
  if (chainId !== BASE_SEPOLIA_CHAIN_ID) throw httpError(400, "wrong_chain", { chainId });
}

/**
 * EIP-1559 payloads are `0x02 || rlp([chainId, ...])`.
 * Chain id 84532 RLP-encodes as 0x83014a34 and must be the first list item.
 */
export function assertSepoliaRawTx(raw) {
  const hex = String(raw || "")
    .toLowerCase()
    .replace(/^0x/, "");
  if (!hex.startsWith("02")) throw httpError(400, "wrong_chain");
  const body = hex.slice(2);
  if (body.length < 4) throw httpError(400, "wrong_chain");
  const prefix = Number.parseInt(body.slice(0, 2), 16);
  const start = prefix <= 0xf7 ? 2 : 2 + (prefix - 0xf7) * 2;
  if (body.slice(start, start + 8) !== "83014a34") throw httpError(400, "wrong_chain");
}

/**
 * Refuse before the relayer signs. Caps are never raised here.
 * @param {{ gas?: bigint, maxFeePerGas?: bigint, maxPriorityFeePerGas?: bigint }} request
 * @param {{ maxGas: number | string, maxFeePerGasWei: string, maxPriorityFeePerGasWei: string }} caps
 */
export function assertPreparedGasCaps(request, caps) {
  const gas = request?.gas == null ? 0n : BigInt(request.gas);
  const fee = request?.maxFeePerGas == null ? 0n : BigInt(request.maxFeePerGas);
  const priority = request?.maxPriorityFeePerGas == null ? 0n : BigInt(request.maxPriorityFeePerGas);
  if (gas > BigInt(caps.maxGas)) {
    throw httpError(429, "gas_cap", { field: "gas", txHash: null, dryRun: false, retryAfter: 1 });
  }
  if (fee > BigInt(caps.maxFeePerGasWei)) {
    throw httpError(429, "gas_cap", { field: "maxFeePerGas", txHash: null, dryRun: false, retryAfter: 1 });
  }
  if (priority > BigInt(caps.maxPriorityFeePerGasWei)) {
    throw httpError(429, "gas_cap", { field: "maxPriorityFeePerGas", txHash: null, dryRun: false, retryAfter: 1 });
  }
}

function assertLocalTx(tx) {
  const chainId = Number(tx?.chainId);
  if (chainId === 1 || chainId === 8453) throw httpError(400, "mainnet_refused", { chainId });
  if (chainId !== BASE_SEPOLIA_CHAIN_ID) throw httpError(400, "wrong_chain", { chainId });
  const to = String(tx?.to || "");
  if (to.toLowerCase() !== BOOKED_SEPOLIA_ESCROW.toLowerCase()) {
    throw httpError(400, "escrow_not_booked_sepolia");
  }
  if (typeof tx?.data !== "string" || !/^0x[0-9a-fA-F]*$/.test(tx.data)) {
    throw httpError(400, "invalid_calldata");
  }
  if (!/^[0-9]+$/.test(String(tx.valueWei ?? "0"))) throw httpError(400, "invalid_amount");
}

function loadAccount(privateKey) {
  const key = String(privateKey || "").trim();
  if (!key) throw httpError(503, "relayer_key_missing", { txHash: null, dryRun: false });
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw httpError(500, "invalid_relayer_key", { txHash: null });
  try {
    return privateKeyToAccount(key);
  } catch {
    throw httpError(500, "invalid_relayer_key", { txHash: null });
  }
}

function asSendError(err, key) {
  if (err?.status && err?.error) {
    if (typeof err.message === "string") err.message = redact(err.message, key);
    if (typeof err.reason === "string") err.reason = redact(err.reason, key);
    if (err.status === 502 && err.error === "broadcast_failed") {
      err.revert_data = revertDataFrom(err, key);
    }
    return err;
  }
  if (isTransientClaimError(err)) {
    const wrapped = new Error("timeout");
    wrapped.error = "broadcast_failed";
    wrapped.revert_data = extractRevertData(err, key);
    return wrapped;
  }
  return httpError(502, "broadcast_failed", {
    txHash: null,
    dryRun: false,
    revert_data: extractRevertData(err, key),
  });
}

function httpRequest(rpcUrl) {
  const transport = http(rpcUrl, { timeout: 20_000 });
  let wired = null;
  return (args) => {
    if (!wired) wired = transport({ chain: baseSepolia });
    return wired.request(args);
  };
}

/**
 * @param {object} [opts]
 * @param {string} [opts.rpcUrl]
 * @param {string} [opts.privateKey]
 * @param {(args: { method: string, params?: unknown[] }) => Promise<unknown>} [opts.request]
 */
export function createSepoliaBroadcaster({ rpcUrl, privateKey, request, gasCaps } = {}) {
  const key = privateKey;
  const rpc = request || httpRequest(rpcUrl || DEFAULT_RPC);
  const caps = gasCaps || loadAbuseLimits({});

  return {
    async send(tx) {
      assertLocalTx(tx);
      let verified = false;

      async function guarded(args) {
        const method = args?.method;
        if (method === "eth_chainId") {
          const result = await rpc(args);
          assertRemoteChain(parseChainId(result));
          verified = true;
          return result;
        }
        if (!verified) throw httpError(400, "wrong_chain");
        if (method === "eth_sendRawTransaction") {
          assertSepoliaRawTx(args?.params?.[0]);
          return rpc(args);
        }
        if (!PREP_METHODS.has(method)) throw httpError(400, "rpc_method_refused", { method });
        return rpc(args);
      }

      try {
        assertRemoteChain(parseChainId(await guarded({ method: "eth_chainId", params: [] })));
        const account = loadAccount(key);
        const client = createWalletClient({
          account,
          chain: baseSepolia,
          transport: custom({
            async request(args) {
              return guarded(args);
            },
          }),
        });
        const prepared = await client.prepareTransactionRequest({
          chain: baseSepolia,
          to: BOOKED_SEPOLIA_ESCROW,
          data: tx.data,
          value: BigInt(tx.valueWei || "0"),
        });
        assertPreparedGasCaps(prepared, caps);
        const serialized = await client.signTransaction(prepared);
        const signedHash = keccak256(serialized);
        const sentHash = await withClaimRetry(async () => {
          const sent = await guarded({ method: "eth_sendRawTransaction", params: [serialized] });
          if (typeof sent !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(sent)) {
            throw httpError(502, "broadcast_failed", { txHash: null, dryRun: false });
          }
          return sent;
        }, { log: () => {} });
        return { txHash: sentHash, signedHash };
      } catch (err) {
        throw asSendError(err, key);
      }
    },
  };
}
