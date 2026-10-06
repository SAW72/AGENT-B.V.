import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RpcRequestError, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { assertSepoliaRawTx, createSepoliaBroadcaster } from "../broadcast.mjs";
import { BOOKED_SEPOLIA_ESCROW } from "../config.mjs";
import { MAX_REVERT_DATA_BYTES } from "../revertData.mjs";

const KEY = "0x" + "11".repeat(32);
const ESCROW_ID = "0x" + "ab".repeat(32);

describe("sepolia broadcaster", () => {
  it("accepts an EIP-1559 payload for chain 84532 and refuses other chain ids", async () => {
    const account = privateKeyToAccount(KEY);
    const signed = await account.signTransaction({
      chainId: 84532,
      nonce: 0,
      gas: 21_000n,
      maxFeePerGas: 100n,
      maxPriorityFeePerGas: 1n,
      to: BOOKED_SEPOLIA_ESCROW,
      value: 0n,
      type: "eip1559",
    });
    assert.equal(assertSepoliaRawTx(signed), undefined);

    const mainnet = await account.signTransaction({
      chainId: 1,
      nonce: 0,
      gas: 21_000n,
      gasPrice: 100n,
      to: BOOKED_SEPOLIA_ESCROW,
      value: 0n,
      type: "legacy",
    });
    assert.throws(() => assertSepoliaRawTx(mainnet), (err) => err.error === "wrong_chain");

    const base = await account.signTransaction({
      chainId: 8453,
      nonce: 0,
      gas: 21_000n,
      maxFeePerGas: 100n,
      maxPriorityFeePerGas: 1n,
      to: BOOKED_SEPOLIA_ESCROW,
      value: 0n,
      type: "eip1559",
    });
    assert.throws(() => assertSepoliaRawTx(base), (err) => err.error === "wrong_chain");
  });

  it("refuses mainnet and the wrong escrow before any RPC", async () => {
    const seen = [];
    const broadcaster = createSepoliaBroadcaster({
      privateKey: KEY,
      request: async ({ method }) => {
        seen.push(method);
        return "0x14a34";
      },
    });
    await assert.rejects(
      () => broadcaster.send({ chainId: 1, to: BOOKED_SEPOLIA_ESCROW, data: "0x1234", valueWei: "0" }),
      (err) => err.error === "mainnet_refused",
    );
    await assert.rejects(
      () => broadcaster.send({ chainId: 8453, to: BOOKED_SEPOLIA_ESCROW, data: "0x1234", valueWei: "0" }),
      (err) => err.error === "mainnet_refused",
    );
    await assert.rejects(
      () =>
        broadcaster.send({
          chainId: 84532,
          to: "0x3333333333333333333333333333333333333333",
          data: "0x1234",
          valueWei: "0",
        }),
      (err) => err.error === "escrow_not_booked_sepolia",
    );
    for (const retired of [
      "0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d",
      "0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c",
    ]) {
      await assert.rejects(
        () => broadcaster.send({ chainId: 84532, to: retired, data: "0x1234", valueWei: "0" }),
        (err) => err.error === "escrow_not_booked_sepolia",
      );
    }
    assert.deepEqual(seen, []);
    assert.equal(JSON.stringify(broadcaster).includes(KEY), false);
  });

  it("stops when the RPC reports mainnet and does not send a raw transaction", async () => {
    const seen = [];
    const broadcaster = createSepoliaBroadcaster({
      privateKey: KEY,
      request: async ({ method }) => {
        seen.push(method);
        if (method === "eth_chainId") return "0x2105";
        throw new Error("should not continue");
      },
    });
    await assert.rejects(
      () => broadcaster.send({ chainId: 84532, to: BOOKED_SEPOLIA_ESCROW, data: "0x1234", valueWei: "0" }),
      (err) => err.error === "mainnet_refused" && err.chainId === 8453,
    );
    assert.deepEqual(seen, ["eth_chainId"]);
  });

  it("signs a release and submits it on the mocked Sepolia RPC", async () => {
    const seen = [];
    let raw = null;
    const broadcaster = createSepoliaBroadcaster({
      privateKey: KEY,
      request: async ({ method, params }) => {
        seen.push(method);
        if (method === "eth_chainId") return "0x14a34";
        if (method === "eth_fillTransaction") throw new Error("eth_fillTransaction is not available");
        if (method === "eth_getTransactionCount") return "0x0";
        if (method === "eth_getBlockByNumber") return sepoliaBlock();
        if (method === "eth_maxPriorityFeePerGas") return "0x59682f00";
        if (method === "eth_gasPrice") return "0x3b9aca00";
        if (method === "eth_estimateGas") return "0x030d40";
        if (method === "eth_call") return "0x";
        if (method === "eth_sendRawTransaction") {
          raw = params[0];
          return "0x" + "cd".repeat(32);
        }
        throw new Error(`unexpected ${method}`);
      },
    });
    const result = await broadcaster.send({
      chainId: 84532,
      to: BOOKED_SEPOLIA_ESCROW,
      data: "0x" + "12".repeat(4) + ESCROW_ID.slice(2),
      valueWei: "0",
    });
    assert.equal(result.txHash, "0x" + "cd".repeat(32));
    assert.equal(seen.includes("eth_sendRawTransaction"), true);
    assert.equal(seen[0], "eth_chainId");
    assertSepoliaRawTx(raw);
    assert.equal(String(raw).toLowerCase().includes(KEY.slice(2)), false);
    assert.equal(JSON.stringify(result).includes(KEY.slice(2)), false);
  });

  it("rebroadcasts the same raw transaction after a timeout", async () => {
    const seen = [];
    const raws = [];
    const broadcaster = createSepoliaBroadcaster({
      privateKey: KEY,
      request: async ({ method, params }) => {
        seen.push(method);
        if (method === "eth_chainId") return "0x14a34";
        if (method === "eth_fillTransaction") throw new Error("eth_fillTransaction is not available");
        if (method === "eth_getTransactionCount") return "0x4";
        if (method === "eth_getBlockByNumber") return sepoliaBlock();
        if (method === "eth_maxPriorityFeePerGas") return "0x59682f00";
        if (method === "eth_gasPrice") return "0x3b9aca00";
        if (method === "eth_estimateGas") return "0x030d40";
        if (method === "eth_call") return "0x";
        if (method === "eth_sendRawTransaction") {
          raws.push(params[0]);
          if (raws.length === 1) throw new Error("timeout");
          return "0x" + "cd".repeat(32);
        }
        throw new Error(`unexpected ${method}`);
      },
    });
    const result = await broadcaster.send({
      chainId: 84532,
      to: BOOKED_SEPOLIA_ESCROW,
      data: "0x" + "12".repeat(4) + ESCROW_ID.slice(2),
      valueWei: "0",
    });
    assert.equal(raws.length, 2);
    assert.equal(raws[0], raws[1]);
    assert.equal(keccak256(raws[0]), keccak256(raws[1]));
    assert.equal(result.signedHash, keccak256(raws[0]));
    assert.equal(result.txHash, "0x" + "cd".repeat(32));
    const nonceReads = seen.filter((method) => method === "eth_getTransactionCount");
    assert.equal(nonceReads.length, 1);
    const firstSend = seen.indexOf("eth_sendRawTransaction");
    assert.equal(seen.indexOf("eth_getTransactionCount") < firstSend, true);
    assert.equal(seen.filter((method) => method === "eth_sendRawTransaction").length, 2);
  });

  it("drops the private key from a broadcast failure", async () => {
    const broadcaster = createSepoliaBroadcaster({
      privateKey: KEY,
      request: async ({ method }) => {
        if (method === "eth_chainId") return "0x14a34";
        throw new Error(`rpc failed ${KEY}`);
      },
    });
    await assert.rejects(
      () => broadcaster.send({ chainId: 84532, to: BOOKED_SEPOLIA_ESCROW, data: "0x", valueWei: "0" }),
      (err) => {
        const blob = JSON.stringify(err);
        return (
          err.error === "broadcast_failed" &&
          err.revert_data === null &&
          err.reason === undefined &&
          !blob.includes(KEY.slice(2)) &&
          !blob.includes(KEY) &&
          !blob.includes("rpc failed")
        );
      },
    );
  });

  it("surfaces estimateGas custom-error bytes and leaves the rpc url and message off the error", async () => {
    const revert = "0x" + "AABBCCDD" + "ab".repeat(32);
    const rpcUrl = "https://sepolia.example/v2/secret-rpc-key";
    const rawMessage = "execution reverted: NotAParty raw-provider-message";
    let estimates = 0;
    const broadcaster = createSepoliaBroadcaster({
      privateKey: KEY,
      request: async ({ method }) => {
        if (method === "eth_chainId") return "0x14a34";
        if (method === "eth_fillTransaction") throw new Error("eth_fillTransaction is not available");
        if (method === "eth_getTransactionCount") return "0x0";
        if (method === "eth_getBlockByNumber") return sepoliaBlock();
        if (method === "eth_maxPriorityFeePerGas") return "0x59682f00";
        if (method === "eth_gasPrice") return "0x3b9aca00";
        if (method === "eth_estimateGas") {
          estimates += 1;
          throw new RpcRequestError({
            body: { method, params: [{ data: "0xdeadbeef", url: rpcUrl }] },
            error: { code: 3, message: rawMessage, data: revert },
            url: rpcUrl,
          });
        }
        throw new Error(`unexpected ${method}`);
      },
    });
    await assert.rejects(
      () => broadcaster.send({ chainId: 84532, to: BOOKED_SEPOLIA_ESCROW, data: "0x1234", valueWei: "0" }),
      (err) => {
        const blob = JSON.stringify(err);
        return (
          err.status === 502 &&
          err.error === "broadcast_failed" &&
          err.revert_data === revert.toLowerCase() &&
          err.reason === undefined &&
          err.txHash === null &&
          err.dryRun === false &&
          !blob.includes(rpcUrl) &&
          !blob.includes("raw-provider-message") &&
          !blob.includes("NotAParty") &&
          !blob.includes("secret-rpc-key") &&
          !blob.includes(KEY.slice(2)) &&
          !blob.includes("0xdeadbeef")
        );
      },
    );
    assert.equal(estimates, 1);
  });

  it("reads nested revert data from a geth-style error and rejects junk, odd, and oversized payloads", async () => {
    const revert = "0x" + "ccdd" + "ee".repeat(32);
    const rpcUrl = "https://user:secret-rpc-key@sepolia.example/v2/key";
    const rawMessage = "execution reverted: keep-this-message-out";

    async function fail(data) {
      const broadcaster = createSepoliaBroadcaster({
        privateKey: KEY,
        request: async ({ method }) => {
          if (method === "eth_chainId") return "0x14a34";
          if (method === "eth_fillTransaction") throw new Error("eth_fillTransaction is not available");
          if (method === "eth_getTransactionCount") return "0x0";
          if (method === "eth_getBlockByNumber") return sepoliaBlock();
          if (method === "eth_maxPriorityFeePerGas") return "0x59682f00";
          if (method === "eth_gasPrice") return "0x3b9aca00";
          if (method === "eth_estimateGas") {
            throw new RpcRequestError({
              body: { method, params: [] },
              error: { code: -32000, message: rawMessage, data },
              url: rpcUrl,
            });
          }
          throw new Error(`unexpected ${method}`);
        },
      });
      try {
        await broadcaster.send({ chainId: 84532, to: BOOKED_SEPOLIA_ESCROW, data: "0x1234", valueWei: "0" });
        return null;
      } catch (err) {
        return err;
      }
    }

    const nested = await fail({ data: revert, message: rawMessage, url: rpcUrl });
    assert.equal(nested.revert_data, revert.toLowerCase());
    const nestedBlob = JSON.stringify(nested);
    assert.equal(nestedBlob.includes(rpcUrl), false);
    assert.equal(nestedBlob.includes("keep-this-message-out"), false);
    assert.equal(nestedBlob.includes("secret-rpc-key"), false);

    const junk = await fail("not-hex " + rpcUrl + " " + rawMessage);
    assert.equal(junk.revert_data, null);
    assert.equal(JSON.stringify(junk).includes(rpcUrl), false);
    assert.equal(JSON.stringify(junk).includes("keep-this-message-out"), false);

    const odd = await fail("0xabc");
    assert.equal(odd.revert_data, null);

    const empty = await fail("0x");
    assert.equal(empty.revert_data, null);

    const oversized = "0x" + "aa".repeat(MAX_REVERT_DATA_BYTES + 1);
    const huge = await fail(oversized);
    assert.equal(huge.revert_data, null);
    assert.equal(JSON.stringify(huge).includes(oversized.slice(0, 32)), false);

    const keyPayload = await fail(KEY);
    assert.equal(keyPayload.revert_data, null);
    assert.equal(JSON.stringify(keyPayload).includes(KEY.slice(2)), false);
  });
});

function sepoliaBlock() {
  return {
    baseFeePerGas: "0x3b9aca00",
    gasLimit: "0x1c9c380",
    gasUsed: "0x0",
    number: "0x1",
    timestamp: "0x65000000",
    hash: "0x" + "11".repeat(32),
    parentHash: "0x" + "22".repeat(32),
    transactions: [],
    miner: "0x" + "33".repeat(20),
    difficulty: "0x0",
    totalDifficulty: "0x0",
    extraData: "0x",
    nonce: "0x0000000000000000",
    size: "0x1",
    stateRoot: "0x" + "44".repeat(32),
  };
}
