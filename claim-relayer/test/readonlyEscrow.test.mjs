import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { ESCROW_VIEW_SIGNATURES, PANEL_VIEW_SIGNATURES, selectorFor } from "../escrowCalldata.mjs";
import { ALLOWED_RPC_METHODS, assessGovernance, assessOwner, readEscrowState, readExpectedOwner } from "../readonlyEscrow.mjs";

const ESCROW = "0x3d660502D75f1e97b08c110255921b437A3C4C42";
const PANEL = "0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb";
const TIMELOCK = "0x10CC9474b45625ADfd05C209f2518023484878D9";

describe("read-only escrow checks", () => {
  it("allows only chain id, eth_call, and code reads", async () => {
    assert.deepEqual(ALLOWED_RPC_METHODS, ["eth_chainId", "eth_call", "eth_getCode"]);
    const panel = await readFile(new URL("../../contracts/DisputePanel.sol", import.meta.url), "utf8");
    assert.match(panel, /uint256 public arbitratorCount/);
  });

  it("stops on mainnet before any contract call", async () => {
    const seen = [];
    await assert.rejects(
      () =>
        readEscrowState({
          rpcUrl: "https://example.test",
          escrowAddress: ESCROW,
          fetchImpl: fakeFetch(seen, { chainId: "0x1" }),
        }),
      (err) => err.error === "mainnet_refused",
    );
    assert.deepEqual(seen, ["eth_chainId"]);
  });

  it("decodes owner, panel, and arbitrator count from eth_call words", async () => {
    const seen = [];
    const state = await readEscrowState({
      rpcUrl: "https://example.test",
      escrowAddress: ESCROW,
      disputePanelAddress: PANEL,
      expectedOwner: TIMELOCK,
      expectedGovernance: TIMELOCK,
      expectedDisputePanel: PANEL,
      fetchImpl: fakeFetch(seen, { chainId: "0x14a34" }),
    });
    assert.equal(state.chainId, 84532);
    assert.equal(state.hasCode, true);
    assert.equal(state.owner.toLowerCase(), TIMELOCK.toLowerCase());
    assert.equal(state.governance.toLowerCase(), TIMELOCK.toLowerCase());
    assert.equal(state.disputePanel.toLowerCase(), PANEL.toLowerCase());
    assert.equal(state.arbitratorCount, "3");
    assert.deepEqual(state.bookMatch, { owner: true, governance: true, disputePanel: true });
    assert.deepEqual(seen, ["eth_chainId", "eth_getCode", "eth_call", "eth_call", "eth_call", "eth_call"]);
  });

  it("passes when the owner is CORE and the expected owner is unset", () => {
    const verdict = assessOwner(TIMELOCK, null, TIMELOCK);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.code, "pre_migration_core");
    assert.match(verdict.message, /pre-migration\/legacy/);
    assert.equal(readExpectedOwner(undefined, null), null);
    assert.equal(readExpectedOwner("", "0x0000000000000000000000000000000000000000"), null);
  });

  it("passes when the owner is the configured timelock", () => {
    const configured = "0x1111111111111111111111111111111111111111";
    const verdict = assessOwner(configured, configured, TIMELOCK);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.code, "configured_owner");
    assert.equal(readExpectedOwner(configured, null), configured);
  });

  it("fails closed when the owner is a timelock and the field is unset", () => {
    const configured = "0x1111111111111111111111111111111111111111";
    const verdict = assessOwner(configured, null, TIMELOCK);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, "expected_owner_unset");
    assert.match(verdict.message, /unset/);
  });

  it("fails closed when the owner is a random address", () => {
    const configured = "0x1111111111111111111111111111111111111111";
    const other = "0x2222222222222222222222222222222222222222";
    const verdict = assessOwner(other, configured, TIMELOCK);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, "owner_mismatch");
    const unset = assessOwner(other, null, TIMELOCK);
    assert.equal(unset.ok, false);
    assert.equal(unset.code, "expected_owner_unset");
  });

  it("accepts CORE governance and configured timelock governance", () => {
    const configured = "0x1111111111111111111111111111111111111111";
    const core = assessGovernance(TIMELOCK, TIMELOCK, null);
    assert.equal(core.ok, true);
    assert.equal(core.code, "pre_migration_core");
    assert.match(core.message, /pre-migration\/legacy/);
    const timelock = assessGovernance(configured, TIMELOCK, configured);
    assert.equal(timelock.ok, true);
    assert.equal(timelock.code, "configured_governance");
    const other = assessGovernance("0x2222222222222222222222222222222222222222", TIMELOCK, configured);
    assert.equal(other.ok, false);
    assert.equal(other.code, "governance_mismatch");
  });

  it("rejects NEW_TIMELOCK equal to CORE", () => {
    const book = "0x1111111111111111111111111111111111111111";
    assert.throws(
      () => readExpectedOwner(TIMELOCK, book, TIMELOCK),
      (err) => err.error === "new_timelock_is_core" && !String(err.message).includes(book),
    );
  });

  it("fails closed on a malformed NEW_TIMELOCK instead of using the book", () => {
    const book = "0x1111111111111111111111111111111111111111";
    assert.throws(
      () => readExpectedOwner("not-an-address", book),
      (err) => err.error === "invalid_new_timelock",
    );
    assert.throws(
      () => readExpectedOwner("0x1234", book),
      (err) => err.error === "invalid_new_timelock",
    );
    assert.equal(readExpectedOwner("  ", book), book);
    assert.equal(readExpectedOwner("0x0000000000000000000000000000000000000000", book), book);
  });
});

function fakeFetch(seen, opts) {
  return async (_url, request) => {
    const body = JSON.parse(request.body);
    seen.push(body.method);
    if (!ALLOWED_RPC_METHODS.includes(body.method)) throw new Error("unexpected method");
    let result = "0x";
    if (body.method === "eth_chainId") result = opts.chainId;
    if (body.method === "eth_getCode") result = "0x600160005260";
    if (body.method === "eth_call") {
      const data = body.params[0].data;
      const to = body.params[0].to;
      if (data === selectorFor(ESCROW_VIEW_SIGNATURES.owner) || data === selectorFor(ESCROW_VIEW_SIGNATURES.governance)) {
        result = wordAddress(TIMELOCK);
      } else if (data === selectorFor(ESCROW_VIEW_SIGNATURES.disputePanel)) {
        result = wordAddress(PANEL);
      } else if (data === selectorFor(PANEL_VIEW_SIGNATURES.arbitratorCount) && to === PANEL) {
        result = "0x" + "3".padStart(64, "0");
      } else {
        throw new Error("unexpected call " + data);
      }
    }
    return { json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
  };
}

function wordAddress(address) {
  return "0x" + address.slice(2).toLowerCase().padStart(64, "0");
}
