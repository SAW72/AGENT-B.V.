/**
 * Read-only chain calls for live claim auth.
 * eth_call and eth_estimateGas, plus the fee reads used to price the gas budget.
 * Broadcast stays in broadcast.mjs.
 * Block tag is always "latest".
 */

import { decodeFunctionResult, encodeFunctionData, hashTypedData, hexToBytes } from "viem";
import { httpError } from "./config.mjs";
import { BASE_SEPOLIA_CHAIN_ID } from "./config.mjs";
import { eip1559MaxFeePerGas } from "./liveAuth.mjs";

const ESCROW_ABI = [
  {
    type: "function",
    name: "escrows",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      { name: "payer", type: "address" },
      { name: "payee", type: "address" },
      { name: "payerBotId", type: "bytes32" },
      { name: "payeeBotId", type: "bytes32" },
      { name: "amount", type: "uint256" },
      { name: "createdAt", type: "uint256" },
      { name: "expiresAt", type: "uint256" },
      { name: "state", type: "uint8" },
      { name: "disputeId", type: "bytes32" },
    ],
  },
  {
    type: "function",
    name: "usedEscrowIds",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  },
];

const ERC1271_ABI = [
  {
    type: "function",
    name: "isValidSignature",
    stateMutability: "view",
    inputs: [
      { name: "hash", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ name: "", type: "bytes4" }],
  },
];

/** ERC-1271 magic value. */
export const ERC1271_MAGIC = "0x1626ba7e";

const ALLOWED_METHODS = new Set([
  "eth_chainId",
  "eth_call",
  "eth_estimateGas",
  "eth_getBlockByNumber",
  "eth_maxPriorityFeePerGas",
]);
const ZERO = "0x0000000000000000000000000000000000000000";

function selectorData(abi, functionName, args) {
  return encodeFunctionData({ abi, functionName, args });
}

function parseChainId(value) {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  const text = String(value ?? "").trim();
  if (/^0x[0-9a-fA-F]+$/.test(text)) return Number(text);
  if (/^[0-9]+$/.test(text)) return Number(text);
  throw httpError(400, "wrong_chain");
}

async function rpcCall(request, method, params) {
  if (!ALLOWED_METHODS.has(method)) throw httpError(400, "rpc_method_refused", { method });
  return request({ method, params });
}

function hexQuantity(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
  const text = String(value ?? "").trim();
  if (/^0x[0-9a-fA-F]+$/.test(text)) return BigInt(text);
  if (/^[0-9]+$/.test(text)) return BigInt(text);
  return null;
}

/** Latest base fee scaled by 1.2, plus the priority fee. Null when the RPC omits either. */
async function quoteMaxFeePerGasWei(request) {
  try {
    const block = await rpcCall(request, "eth_getBlockByNumber", ["latest", false]);
    const base = hexQuantity(block?.baseFeePerGas);
    if (base == null) return null;
    const priority = hexQuantity(await rpcCall(request, "eth_maxPriorityFeePerGas", []));
    if (priority == null) return null;
    const maxFee = eip1559MaxFeePerGas(base, priority);
    return maxFee > 0n ? maxFee : null;
  } catch {
    return null;
  }
}

/** JSON-RPC POST. The method allowlist is enforced in rpcCall before this runs. */
export function httpRpcRequest(rpcUrl, fetchImpl = globalThis.fetch) {
  return async function request(args) {
    const response = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: args.method, params: args.params || [] }),
    });
    const json = await response.json();
    if (!json || json.error) {
      const data = json?.error?.data;
      throw Object.assign(new Error("rpc_error"), { error: "rpc_error", data: typeof data === "string" ? data : data?.data });
    }
    return json.result;
  };
}

/**
 * @param {object} opts
 * @param {string} opts.escrowAddress
 * @param {string} opts.from relayer address used as eth_call `from`
 * @param {string} [opts.rpcUrl]
 * @param {(args: { method: string, params?: unknown[] }) => Promise<unknown>} [opts.request]
 * @param {bigint} [opts.fallbackGasUsed]
 */
export function createRpcEscrowChain(opts) {
  const request = opts.request || httpRpcRequest(opts.rpcUrl || "https://sepolia.base.org");
  const escrowAddress = opts.escrowAddress;
  const from = opts.from;
  const fallbackGasUsed = opts.fallbackGasUsed ?? 120_000n;
  let chainChecked = false;

  async function assertChain() {
    if (chainChecked) return;
    const raw = await rpcCall(request, "eth_chainId", []);
    const chainId = parseChainId(raw);
    if (chainId === 1 || chainId === 8453) throw httpError(400, "mainnet_refused", { chainId });
    if (chainId !== BASE_SEPOLIA_CHAIN_ID) throw httpError(400, "wrong_chain", { chainId });
    chainChecked = true;
  }

  async function ethCall(data, to = escrowAddress) {
    await assertChain();
    if (!to) throw httpError(409, "escrow_not_booked");
    try {
      return await rpcCall(request, "eth_call", [{ to, from, data }, "latest"]);
    } catch (err) {
      const revertData = revertHex(err);
      throw httpError(502, "broadcast_failed", { txHash: null, dryRun: false, revert_data: revertData });
    }
  }

  return {
    async readEscrow(escrowId) {
      const usedData = selectorData(ESCROW_ABI, "usedEscrowIds", [escrowId]);
      const rowData = selectorData(ESCROW_ABI, "escrows", [escrowId]);
      const [usedRaw, rowRaw] = await Promise.all([ethCall(usedData), ethCall(rowData)]);
      const used = decodeFunctionResult({ abi: ESCROW_ABI, functionName: "usedEscrowIds", data: usedRaw });
      const row = decodeFunctionResult({ abi: ESCROW_ABI, functionName: "escrows", data: rowRaw });
      const payer = row[0];
      const payee = row[1];
      const exists = used === true && String(payer).toLowerCase() !== ZERO;
      return { exists, payer, payee };
    },

    /**
     * @param {string} account
     * @param {{ domain: object, types: object, primaryType: string, message: object }} typed
     * @param {string} signature
     */
    async isValidSignature(account, typed, signature) {
      const hash = hashTypedData(typed);
      const data = selectorData(ERC1271_ABI, "isValidSignature", [hash, signature]);
      let raw;
      try {
        raw = await ethCall(data, account);
      } catch {
        return false;
      }
      try {
        const magic = decodeFunctionResult({ abi: ERC1271_ABI, functionName: "isValidSignature", data: raw });
        return String(magic).toLowerCase() === ERC1271_MAGIC;
      } catch {
        return false;
      }
    },

    /**
     * eth_estimateGas is the pre-broadcast simulation. A revert does not send.
     * @param {{ to: string, data: string, valueWei: string }} tx
     */
    async simulate(tx) {
      await assertChain();
      try {
        const gasHex = await rpcCall(request, "eth_estimateGas", [
          {
            from,
            to: tx.to,
            data: tx.data,
            value: "0x" + BigInt(tx.valueWei || "0").toString(16),
          },
        ]);
        const gasUsed = typeof gasHex === "bigint" ? gasHex : BigInt(gasHex);
        const maxFeePerGasWei = await quoteMaxFeePerGasWei(request);
        const result = { ok: true, gasUsed: gasUsed > 0n ? gasUsed : fallbackGasUsed, revertData: null };
        if (maxFeePerGasWei != null) result.maxFeePerGasWei = maxFeePerGasWei;
        return result;
      } catch (err) {
        return { ok: false, gasUsed: 0n, revertData: revertHex(err) };
      }
    },
  };
}

function revertHex(err) {
  const candidates = [err?.data, err?.revert_data, err?.cause?.data];
  for (const value of candidates) {
    if (typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value) && value.length > 2 && value.length % 2 === 0) {
      if (hexToBytes(value).length > 4096) return null;
      return value.toLowerCase();
    }
  }
  return null;
}

