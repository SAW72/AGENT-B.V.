import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  CallExecutionError,
  ExecutionRevertedError,
  RpcRequestError,
  hashDomain,
  keccak256,
  parseEther,
  recoverTypedDataAddress,
  toBytes,
  toHex,
  type Hex,
} from "viem"
import { mnemonicToAccount } from "viem/accounts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  CLAIM_INTENT_ACTIONS,
  CLAIM_INTENT_ACTION_VALUES,
  CLAIM_INTENT_REFUSED_ACTIONS,
  CLAIM_INTENT_DOMAIN_NAME,
  CLAIM_INTENT_DOMAIN_VERSION,
  CLAIM_INTENT_PRIMARY_TYPE,
  CLAIM_INTENT_TYPE_STRING,
  CLAIM_INTENT_TYPES,
} from "./claimIntent"
import { previewCreateEscrow, previewDispute, previewOpenDispute, previewRefund, previewRelease } from "./preview"
import {
  claimBodyFromPreview,
  postLiveClaim,
  presentRelayerError,
  RelayerRequestError,
  readRelayerHealth,
  readRelayerPaused,
  relayerHealthWakes,
  watchRelayerHealth,
  RELAYER_HEALTH_RETRY_MS,
  RELAYER_HEALTH_TIMEOUT_MS,
  RELAYER_HEALTH_WAKE_CAP_MS,
  RELAYER_CHECK_WALLET_LABEL,
  RELAYER_CHECKING_NOTE,
  RELAYER_CONNECT_NOTE,
  RELAYER_COULD_NOT_SUBMIT,
  RELAYER_DOWN_NOTE,
  RELAYER_PAUSED_NOTE,
  RELAYER_RECEIPT_REVERTED_TEXT,
  RELAYER_RECEIPT_UNKNOWN_TEXT,
  RELAYER_TIMEOUT_TEXT,
  relayerButtonModel,
  relayerConfigFromEnv,
  relayerErrorText,
  relayerSubmitAllowed,
  relayerTxUrl,
  relayerWalletUrl,
  runRelayerSubmission,
  type ClaimSignArgs,
  type SignedLiveClaim,
} from "./relayer"

const escrow = "0x3d660502D75f1e97b08c110255921b437A3C4C42" as const
const panel = "0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb" as const
const id = `0x${"ab".repeat(32)}` as const
const other = `0x${"cd".repeat(32)}` as const
const payee = "0x0000000000000000000000000000000000000002" as const
const txHash = `0x${"ef".repeat(32)}` as const
const relayerUrl = "https://bot-verifier-claim-relayer.onrender.com"
const TEST_MNEMONIC = "test test test test test test test test test test test junk"
const payerAccount = mnemonicToAccount(TEST_MNEMONIC)
const CLAIM_INTENT_TYPEHASH = "0x1f13fdcc6f1390de5e43ffa26909f5e100cb78aaa1cf33d9abdf7d71a4cde0d2"

function signerInput(sign?: (args: ClaimSignArgs) => Promise<Hex>) {
  return {
    sender: payerAccount.address,
    verifyingContract: escrow,
    signTypedData: sign ?? ((args: ClaimSignArgs) => payerAccount.signTypedData(args)),
  }
}

function liveBody(preview: ReturnType<typeof previewRelease>, chainId = 84532): SignedLiveClaim {
  const claim = claimBodyFromPreview(preview)
  return {
    live: true,
    signature: `0x${"11".repeat(65)}`,
    intent: {
      action: claim.action,
      escrowId: claim.claimId,
      sender: payerAccount.address,
      nonce: "7",
      deadline: "1893456000",
      chainId,
      verifyingContract: escrow,
    },
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

describe("relayer config", () => {
  it("stays unset when the URL is missing so submits stay wallet-direct", () => {
    expect(relayerConfigFromEnv({})).toEqual({ url: null })
    expect(relayerConfigFromEnv({ VITE_CLAIM_RELAYER_URL: "  " })).toEqual({ url: null })
  })

  it("keeps the public URL and does not read an escrow secret", () => {
    expect(relayerConfigFromEnv({ VITE_CLAIM_RELAYER_URL: `${relayerUrl}/` })).toEqual({ url: relayerUrl })
    expect(relayerConfigFromEnv({ VITE_CLAIM_RELAYER_URL: relayerUrl })).not.toHaveProperty("secret")
  })
})

describe("relayer chain guard", () => {
  it("requires a connected Base Sepolia wallet so the escrow can be signed", () => {
    const disconnected = relayerSubmitAllowed({ walletConnected: false, walletChainId: null })
    expect(disconnected).toEqual({ ok: false, reason: RELAYER_CONNECT_NOTE })
    expect(relayerSubmitAllowed({ walletConnected: true, walletChainId: 84532 })).toEqual({ ok: true })
  })

  it("refuses a connected mainnet wallet", () => {
    const ethereum = relayerSubmitAllowed({ walletConnected: true, walletChainId: 1 })
    const base = relayerSubmitAllowed({ walletConnected: true, walletChainId: 8453 })
    expect(ethereum.ok).toBe(false)
    expect(base.ok).toBe(false)
    if (!ethereum.ok) expect(ethereum.reason).toMatch(/chain id 1/)
    if (!base.ok) expect(base.reason).toMatch(/8453/)
  })
})

describe("postLiveClaim", () => {
  const releasePreview = previewRefund(escrow, id)
  const release = liveBody(releasePreview)

  it("posts a signed intent on chain 84532 and does not send an escrow secret", async () => {
    const captured: { url: string; init: RequestInit } = { url: "", init: {} }
    const result = await postLiveClaim({
      url: relayerUrl,
      body: release,
      fetchImpl: async (url, init) => {
        captured.url = String(url)
        captured.init = init ?? {}
        return jsonResponse(200, { ok: true, mode: "live", txHash })
      },
    })
    expect(result).toEqual({ txHash, mode: "live", escrowAddress: null })
    expect(captured.url).toBe(`${relayerUrl}/v1/claims`)
    const headers = new Headers(captured.init.headers)
    expect(headers.get("x-claim-secret")).toBeNull()
    expect(headers.get("authorization")).toBeNull()
    expect(headers.get("content-type")).toBe("application/json")
    const body = JSON.parse(String(captured.init.body)) as SignedLiveClaim
    expect(body.live).toBe(true)
    expect(body).not.toHaveProperty("calldata")
    expect(body.intent).not.toHaveProperty("calldataHash")
    expect(body.intent.chainId).toBe(84532)
    expect(body.intent.action).toBe("refund")
    expect(body.intent.escrowId).toBe(id)
    expect(body.intent.sender).toBe(payerAccount.address)
  })

  it("surfaces 401, 503, and CORS without calling a mainnet chain", async () => {
    const unauthorized = postLiveClaim({
      url: relayerUrl,
      body: release,
      fetchImpl: async () => jsonResponse(401, { ok: false, error: "unauthorized" }),
    })
    await expect(unauthorized).rejects.toMatchObject({ status: 401, code: "unauthorized" })
    await expect(unauthorized).rejects.toThrow(/401 unauthorized/)

    const closed = postLiveClaim({
      url: relayerUrl,
      body: release,
      fetchImpl: async () => jsonResponse(503, { ok: false, error: "relayer_key_missing" }),
    })
    await expect(closed).rejects.toMatchObject({ status: 503, code: "relayer_key_missing" })
    await expect(closed).rejects.toThrow(/503 relayer_key_missing/)

    const userMessage =
      "Couldn't reach the refund service. Try again in a minute. If it keeps failing, check Pending transactions before trying again."
    const origin = "https://current.example"
    vi.stubGlobal("window", { location: { origin } })
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const cors = postLiveClaim({
        url: relayerUrl,
        body: release,
        fetchImpl: async () => {
          throw new TypeError("Failed to fetch")
        },
      })
      await expect(cors).rejects.toMatchObject({ code: "cors_or_network", status: null })
      await expect(cors).rejects.toThrow(userMessage)
      const error = await cors.catch((cause: unknown) => cause)
      expect(relayerErrorText(error)).toBe(userMessage)
      expect(relayerErrorText(error)).not.toMatch(/CORS/)
      expect(relayerErrorText(error)).not.toMatch(/Render/)
      expect(relayerErrorText(error)).not.toMatch(/pages\.dev/)
      expect(relayerErrorText(error)).not.toMatch(/agent-a/)
      expect(presentRelayerError(error).main).toBe(userMessage)
      const logged = consoleError.mock.calls.map((args) => args.map(String).join(" ")).join("\n")
      expect(logged).toContain(origin)
      expect(logged).toMatch(/CORS on the relayer/)
      expect(logged).not.toMatch(/agent-a/)
      expect(logged).not.toMatch(/pages\.dev/)
      await expect(cors).rejects.not.toThrow(/x-claim-secret/)
    } finally {
      consoleError.mockRestore()
      vi.unstubAllGlobals()
    }

    const consoleErrorBare = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const offline = postLiveClaim({
        url: relayerUrl,
        body: release,
        fetchImpl: async () => {
          throw new TypeError("Failed to fetch")
        },
      })
      await expect(offline).rejects.toThrow(userMessage)
      const logged = consoleErrorBare.mock.calls.map((args) => args.map(String).join(" ")).join("\n")
      expect(logged).toMatch(/CORS on the relayer/)
      expect(logged).not.toMatch(/agent-a/)
      expect(logged).not.toMatch(/pages\.dev/)
    } finally {
      consoleErrorBare.mockRestore()
    }

    let fetches = 0
    const mainnet = postLiveClaim({
      url: relayerUrl,
      body: liveBody(releasePreview, 1),
      fetchImpl: async () => {
        fetches += 1
        return jsonResponse(200, { ok: true, mode: "live", txHash })
      },
    })
    await expect(mainnet).rejects.toMatchObject({ code: "mainnet_refused" })
    const baseMainnet = postLiveClaim({
      url: relayerUrl,
      body: liveBody(releasePreview, 8453),
      fetchImpl: async () => {
        fetches += 1
        return jsonResponse(200, { ok: true, mode: "live", txHash })
      },
    })
    await expect(baseMainnet).rejects.toMatchObject({ code: "mainnet_refused" })
    expect(fetches).toBe(0)
  })

  it("refuses a credentialed URL and openDispute", async () => {
    let fetches = 0
    await expect(
      postLiveClaim({
        url: "https://user:secret@bot-verifier-claim-relayer.onrender.com",
        body: liveBody(releasePreview),
        fetchImpl: async () => {
          fetches += 1
          return jsonResponse(200, { ok: true, mode: "live", txHash })
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_relayer_url" })
    expect(fetches).toBe(0)
    expect(() => claimBodyFromPreview(previewOpenDispute(panel, other, id, "wallet only"))).toThrow(
      /your wallet/,
    )
    expect(() =>
      claimBodyFromPreview(
        previewCreateEscrow({
          escrow,
          escrowId: id,
          payee,
          payerBotId: id,
          payeeBotId: other,
          durationSeconds: 3600n,
          valueWei: parseEther("0.01"),
        }),
      ),
    ).toThrow(/your wallet/)
    expect(() => claimBodyFromPreview(previewDispute(escrow, id, other, "wallet only"))).toThrow(/your wallet/)
  })
})

describe("relayer broadcast failures", () => {
  it("shows plain English for 502 broadcast_failed and keeps the raw status in the details", async () => {
    const body = liveBody(previewRefund(escrow, id))
    const failed = postLiveClaim({
      url: relayerUrl,
      body,
      fetchImpl: async () =>
        jsonResponse(502, { error: "broadcast_failed", reason: "Execution reverted for an unknown reason." }),
    })
    await expect(failed).rejects.toThrow(/502 broadcast_failed/)
    const error = await postLiveClaim({
      url: relayerUrl,
      body,
      fetchImpl: async () =>
        jsonResponse(502, { error: "broadcast_failed", reason: "Execution reverted for an unknown reason." }),
    }).catch((cause: unknown) => cause)
    const presented = presentRelayerError(error)
    expect(presented.main).toBe(RELAYER_COULD_NOT_SUBMIT)
    expect(presented.main).not.toMatch(/502|broadcast_failed|Execution reverted|unknown reason/)
    expect(presented.detail).toBe("Details: 502 broadcast_failed")
  })

  it("decodes revert_data on a 502 and still works when that field is absent", async () => {
    const body = liveBody(previewRefund(escrow, id))
    const withData = await postLiveClaim({
      url: relayerUrl,
      body,
      fetchImpl: async () =>
        jsonResponse(502, { error: "broadcast_failed", reason: "Execution reverted", revert_data: "0xf10068b5" }),
    }).catch((cause: unknown) => cause)
    const decoded = presentRelayerError(withData)
    expect(decoded.main).toBe("Filing opens the panel case in the same transaction. A case that is already resolved is not opened on this escrow.")
    expect(decoded.detail).toContain("DisputeAlreadyResolved")
    expect(decoded.detail).toContain("0xf10068b5")
    expect(decoded.detail).toContain("502 broadcast_failed")
    expect(decoded.main).not.toContain("0xf10068b5")

    const fromRevertData = await postLiveClaim({
      url: relayerUrl,
      body,
      fetchImpl: async () =>
        jsonResponse(502, {
          error: "broadcast_failed",
          revert_data: null,
          revertData: "0x8aab0a8f",
          data: "0x9bc3a099",
        }),
    }).catch((cause: unknown) => cause)
    const revertDataHit = presentRelayerError(fromRevertData)
    expect(revertDataHit.main).toBe(
      "Filing opens the panel case in the same transaction. Votes cast on another case are not read.",
    )
    expect(revertDataHit.detail).toContain("0x8aab0a8f")
    expect(revertDataHit.main).not.toMatch(/0x[0-9a-fA-F]+/)
    expect(revertDataHit.main).not.toMatch(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/)

    const fromData = await postLiveClaim({
      url: relayerUrl,
      body,
      fetchImpl: async () =>
        jsonResponse(502, {
          error: "broadcast_failed",
          revert_data: "",
          revertData: "0x",
          data: "0x9bc3a099",
        }),
    }).catch((cause: unknown) => cause)
    const dataHit = presentRelayerError(fromData)
    expect(dataHit.main).toBe("Filing opens the panel case in the same transaction. A case opened before this escrow is not opened on this escrow.")
    expect(dataHit.detail).toContain("0x9bc3a099")
    expect(dataHit.main).not.toContain("0x9bc3a099")

    const absent = await postLiveClaim({
      url: relayerUrl,
      body,
      fetchImpl: async () => jsonResponse(502, { error: "broadcast_failed" }),
    }).catch((cause: unknown) => cause)
    const plain = presentRelayerError(absent)
    expect(plain.main).toBe(RELAYER_COULD_NOT_SUBMIT)
    expect(plain.detail).toBe("Details: 502 broadcast_failed")
  })
})

describe("wallet submit stays direct unless the UI opts in", () => {
  it("keeps submit.ts free of the relayer and wires errors in FlowPreview", () => {
    const dir = dirname(fileURLToPath(import.meta.url))
    const submit = readFileSync(join(dir, "submit.ts"), "utf8")
    const flow = readFileSync(join(dir, "FlowPreview.tsx"), "utf8")
    expect(submit).not.toContain("VITE_CLAIM_RELAYER_URL")
    expect(submit).not.toContain("postLiveClaim")
    expect(flow).toContain("sendTransactionAsync")
    expect(flow).toContain("runRelayerSubmission")
    expect(flow).toContain('data-testid="relayer-submit"')
    expect(flow).toContain('data-testid="relayer-tx-link"')
    expect(flow).toContain("relayer.url")
    expect(flow).toContain("RELAYER_SUBMITTING_TEXT")
    expect(flow).toContain("RELAYER_WAITING_TEXT")
    expect(flow).toContain("relayerFlight")
    expect(flow).toContain("if (relayerFlight.current) return")
    expect(flow).toContain("signTypedData")
    expect(flow).toContain("readRelayerHealth")
    expect(flow).not.toContain("VITE_CLAIM_API_SECRET")
    expect(flow).not.toContain("x-claim-secret")
  })
})

const retiredEscrow = "0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c"
const retiredEscM1 = "0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d"
const relayerPackage = join(dirname(fileURLToPath(import.meta.url)), "../../../claim-relayer")

function rpcRevert(data: Hex) {
  const rpc = new RpcRequestError({
    body: { method: "eth_call", params: [] },
    error: { code: 3, message: "execution reverted", data },
    url: "http://127.0.0.1:8545",
  })
  const reverted = new ExecutionRevertedError({ cause: rpc, message: rpc.details })
  return new CallExecutionError(reverted, { to: escrow, data: "0x" })
}

function assertServerBuildsCalldata(): void {
  const claimsSource = readFileSync(join(relayerPackage, "claims.mjs"), "utf8")
  const liveSource = readFileSync(join(relayerPackage, "liveAuth.mjs"), "utf8")
  expect(claimsSource).toContain("const encoded = prepared?.encoded || describeCalldata(body)")
  expect(liveSource).toContain('const LIVE_ACTIONS = new Set(["refund"])')
  expect(liveSource).toContain("release_not_relayable")
  expect(liveSource).toContain("encodeEscrowAction({ action: intent.action, escrowId: intent.escrowId })")
}

function readyClient(receipt: { status: "success" | "reverted" } | Error) {
  return {
    call: vi.fn(async () => "0x"),
    waitForTransactionReceipt: vi.fn(async () => {
      if (receipt instanceof Error) throw receipt
      return receipt
    }),
  }
}

describe("release is not relayed", () => {
  it("refuses a relayed release before signing, simulation, or a post", async () => {
    const sign = vi.fn(async (args: ClaimSignArgs) => payerAccount.signTypedData(args))
    const client = {
      call: vi.fn(async () => "0x"),
      waitForTransactionReceipt: vi.fn(),
    }
    let fetches = 0
    const result = await runRelayerSubmission({
      url: relayerUrl,
      ...signerInput(sign),
      preview: previewRelease(escrow, id),
      client,
      fetchImpl: async () => {
        fetches += 1
        return jsonResponse(200, { ok: true, mode: "live", txHash })
      },
    })
    expect(sign).not.toHaveBeenCalled()
    expect(client.call).not.toHaveBeenCalled()
    expect(client.waitForTransactionReceipt).not.toHaveBeenCalled()
    expect(fetches).toBe(0)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("release_not_relayable")
      expect(result.presentation.main).toBe(
        "Only the payer can release an open escrow; after an upheld dispute, the payer or the payee. Send it from that wallet. Nothing was sent.",
      )
    }
  })

  it("explains a ruling_pending refusal in plain English", () => {
    const presented = presentRelayerError(new RelayerRequestError("ruling_pending", 409, "ruling_pending"))
    expect(presented.main).toBe(
      "A dispute ruling is pending. Refund opens 7 days after expiry if the panel has not ruled. Nothing was sent.",
    )
    expect(presented.main).not.toMatch(/409|ruling_pending/)
  })
})

describe("refund submit via the refund service", () => {
  const release = previewRefund(escrow, id)

  it("posts a signed refund and lets the relayer build the calldata", async () => {
    const phases: string[] = []
    let posted = ""
    let method = ""
    let secretHeader: string | null = null
    let target = ""
    const client = readyClient({ status: "success" })
    const result = await runRelayerSubmission({
      url: relayerUrl,
      ...signerInput(),
      preview: release,
      client,
      onPhase: (phase) => phases.push(phase),
      fetchImpl: async (url, init) => {
        target = String(url)
        method = String(init?.method)
        posted = String(init?.body)
        secretHeader = new Headers(init?.headers).get("x-claim-secret")
        expect(new Headers(init?.headers).get("content-type")).toBe("application/json")
        return jsonResponse(200, {
          ok: true,
          mode: "live",
          txHash,
          escrowAddress: escrow,
          chainId: 84532,
        })
      },
    })
    expect(phases).toEqual(["submitting", "confirming"])
    expect(method).toBe("POST")
    expect(target).toBe(`${relayerUrl}/v1/claims`)
    expect(secretHeader).toBeNull()
    const body = JSON.parse(posted) as SignedLiveClaim
    expect(body.live).toBe(true)
    expect(body).not.toHaveProperty("calldata")
    expect(body.intent).not.toHaveProperty("calldataHash")
    expect(body.intent.action).toBe("refund")
    expect(body.intent.escrowId).toBe(id)
    expect(body.intent.chainId).toBe(84532)
    expect(body.intent.verifyingContract).toBe(escrow)
    expect(body.intent.sender).toBe(payerAccount.address)
    expect(body).not.toHaveProperty("amountWei")
    assertServerBuildsCalldata()
    expect(client.call).toHaveBeenCalledWith({
      account: "0x9D1b3E1400D2632d435cB7C0fC131C4f42B31861",
      to: escrow,
      data: release.calldata,
      value: 0n,
    })
    expect(result).toEqual({ ok: true, txHash })
    expect(relayerTxUrl(txHash)).toBe(`https://sepolia.basescan.org/tx/${txHash}`)
  })

  it("rejects a non-relayer action before any eth_call or fetch", async () => {
    let fetches = 0
    const client = {
      call: vi.fn(async () => "0x"),
      waitForTransactionReceipt: vi.fn(),
    }
    const result = await runRelayerSubmission({
      url: relayerUrl,
      ...signerInput(),
      preview: previewOpenDispute(panel, other, id, "wallet only"),
      client,
      fetchImpl: async () => {
        fetches += 1
        return jsonResponse(200, { ok: true, mode: "live", txHash })
      },
    })
    expect(client.call).not.toHaveBeenCalled()
    expect(fetches).toBe(0)
    expect(client.waitForTransactionReceipt).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("action_not_claim")
      expect(result.presentation.main).toBe("This step has to be sent from your wallet, not the refund service.")
    }
    const dispute = await runRelayerSubmission({
      url: relayerUrl,
      ...signerInput(),
      preview: previewDispute(escrow, id, other, "wallet only"),
      client,
      fetchImpl: async () => {
        fetches += 1
        return jsonResponse(200, { ok: true, mode: "live", txHash })
      },
    })
    expect(fetches).toBe(0)
    expect(dispute.ok).toBe(false)
    if (!dispute.ok) expect(dispute.code).toBe("action_not_claim")
  })

  it("does not post when the relayer-wallet simulation reverts", async () => {
    let fetches = 0
    const client = {
      call: vi.fn(async () => {
        throw rpcRevert("0xf10068b5")
      }),
      waitForTransactionReceipt: vi.fn(),
    }
    const result = await runRelayerSubmission({
      url: relayerUrl,
      ...signerInput(),
      preview: release,
      client,
      fetchImpl: async () => {
        fetches += 1
        return jsonResponse(200, { ok: true, mode: "live", txHash })
      },
    })
    expect(fetches).toBe(0)
    expect(client.waitForTransactionReceipt).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.presentation.main).toBe("Filing opens the panel case in the same transaction. A case that is already resolved is not opened on this escrow.")
    }
  })

  it("keeps a timed-out post unknown and points at the relayer wallet", async () => {
    const result = await runRelayerSubmission({
      url: relayerUrl,
      ...signerInput(),
      preview: release,
      client: readyClient({ status: "success" }),
      fetchTimeoutMs: 20,
      fetchImpl: () => new Promise(() => undefined),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("timeout_unknown")
    expect(result.presentation.main).toBe(RELAYER_TIMEOUT_TEXT)
    expect(result.presentation.main.toLowerCase()).not.toContain("nothing was sent")
    expect(result.presentation.main).not.toMatch(/[()]/)
    expect(result.presentation.detail).toBe("Details: timeout_unknown")
    expect(result.presentation.link).toEqual({ href: relayerWalletUrl(), label: RELAYER_CHECK_WALLET_LABEL })
  })

  it("links the transaction when the receipt never arrives", async () => {
    const result = await runRelayerSubmission({
      url: relayerUrl,
      ...signerInput(),
      preview: release,
      client: readyClient(Object.assign(new Error("Timed out while waiting for transaction."), { name: "WaitForTransactionReceiptTimeoutError" })),
      fetchImpl: async () => jsonResponse(200, { ok: true, mode: "live", txHash, escrowAddress: escrow }),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("receipt_unknown")
    expect(result.txHash).toBe(txHash)
    expect(result.presentation.main).toBe(RELAYER_RECEIPT_UNKNOWN_TEXT)
    expect(result.presentation.main.toLowerCase()).not.toContain("nothing was sent")
    expect(result.presentation.link?.href).toBe(relayerTxUrl(txHash))
  })

  it("explains a reverted receipt in plain English and keeps the transaction link", async () => {
    let calls = 0
    const client = {
      call: vi.fn(async () => {
        calls += 1
        if (calls === 1) return "0x"
        throw rpcRevert("0xf10068b5")
      }),
      waitForTransactionReceipt: vi.fn(async () => ({ status: "reverted" as const })),
    }
    const decoded = await runRelayerSubmission({
      url: relayerUrl,
      ...signerInput(),
      preview: release,
      client,
      fetchImpl: async () => jsonResponse(200, { ok: true, mode: "live", txHash, escrowAddress: escrow }),
    })
    expect(decoded.ok).toBe(false)
    if (decoded.ok) return
    expect(decoded.presentation.main).toBe("Filing opens the panel case in the same transaction. A case that is already resolved is not opened on this escrow.")
    expect(decoded.presentation.link?.href).toBe(relayerTxUrl(txHash))
    expect(decoded.presentation.main).not.toMatch(/[()]/)

    const plain = await runRelayerSubmission({
      url: relayerUrl,
      ...signerInput(),
      preview: release,
      client: readyClient({ status: "reverted" }),
      fetchImpl: async () => jsonResponse(200, { ok: true, mode: "live", txHash, escrowAddress: escrow }),
    })
    expect(plain.ok).toBe(false)
    if (plain.ok) return
    expect(plain.presentation.main).toBe(RELAYER_RECEIPT_REVERTED_TEXT)
    expect(plain.presentation.main).toContain("The transaction was sent")
    expect(plain.presentation.main).toContain("no escrow funds moved")
    expect(plain.presentation.main).not.toContain("No funds moved")
    expect(plain.presentation.main).not.toMatch(/Nothing was sent/)
    expect(plain.presentation.link?.href).toBe(relayerTxUrl(txHash))
  })
})

describe("relayer response copy", () => {
  const release = previewRefund(escrow, id)
  const cases: { status: number; body: Record<string, unknown>; main: string; detail: string }[] = [
    {
      status: 400,
      body: { ok: false, error: "invalid_json" },
      main: "The refund service could not accept this submission. Nothing was sent.",
      detail: "Details: 400 invalid_json",
    },
    {
      status: 401,
      body: { ok: false, error: "unauthorized" },
      main: "The refund service refused this request. Nothing was sent.",
      detail: "Details: 401 unauthorized",
    },
    {
      status: 403,
      body: { ok: false, error: "forbidden" },
      main: "The refund service refused this request. Nothing was sent.",
      detail: "Details: 403 forbidden",
    },
    {
      status: 404,
      body: { ok: false, error: "not_found" },
      main: "The refund service could not find that submission path. Nothing was sent.",
      detail: "Details: 404 not_found",
    },
    {
      status: 409,
      body: { ok: false, error: "live_submit_blocked", reason: "live_submit_off", txHash: null },
      main: "The refund service isn't accepting live submissions right now. Nothing was sent.",
      detail: "Details: 409 live_submit_blocked",
    },
    {
      status: 422,
      body: { ok: false, error: "unprocessable" },
      main: "The refund service could not accept this submission. Nothing was sent.",
      detail: "Details: 422 unprocessable",
    },
    {
      status: 429,
      body: { ok: false, error: "rate_limited" },
      main: "The refund service is limiting submissions. Wait a moment and try again. Nothing was sent.",
      detail: "Details: 429 rate_limited",
    },
    {
      status: 400,
      body: { ok: false, error: "high_s" },
      main: "This approval signature is not in the required form. Nothing was sent.",
      detail: "Details: 400 high_s",
    },
    {
      status: 400,
      body: { ok: false, error: "trailing_bytes" },
      main: "The prepared transaction has extra data, so it was not submitted.",
      detail: "Details: 400 trailing_bytes",
    },
    {
      status: 409,
      body: { ok: false, error: "nonce_replay" },
      main: "This approval was already used. Nothing was sent.",
      detail: "Details: 409 nonce_replay",
    },
    {
      status: 400,
      body: {
        ok: false,
        error: "retired_or_superseded_address",
        address: retiredEscrow,
        current: escrow,
      },
      main: "The refund service is pointed at a retired escrow, so this was not submitted. Use your wallet instead.",
      detail: "Details: 400 retired_or_superseded_address",
    },
    {
      status: 409,
      body: {
        ok: false,
        error: "live_submit_blocked",
        reason: "escrow_not_booked_sepolia",
        escrowAddress: retiredEscrow,
        txHash: null,
      },
      main: "The refund service is pointed at a retired escrow, so this was not submitted. Use your wallet instead.",
      detail: "Details: 409 live_submit_blocked",
    },
    {
      status: 503,
      body: { ok: false, error: "kill_switch" },
      main: "The refund service is paused. Nothing was sent.",
      detail: "Details: 503 kill_switch",
    },
  ]

  it("maps client errors to plain English and keeps the raw status in the details", async () => {
    for (const item of cases) {
      const result = await runRelayerSubmission({
        url: relayerUrl,
        ...signerInput(),
        preview: release,
        client: readyClient({ status: "success" }),
        fetchImpl: async () => jsonResponse(item.status, item.body),
      })
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.presentation.main).toBe(item.main)
      expect(result.presentation.detail).toBe(item.detail)
      expect(result.presentation.main).not.toMatch(/[()]/)
      expect(result.presentation.main).not.toContain(String(item.status))
      const code = String(item.body.error)
      expect(result.presentation.main).not.toContain(code)
    }
  })

  it("treats a live hash aimed at a retired escrow as already submitted", async () => {
    for (const retired of [retiredEscrow, retiredEscM1]) {
      const client = readyClient({ status: "success" })
      const result = await runRelayerSubmission({
        url: relayerUrl,
        ...signerInput(),
        preview: release,
        client,
        fetchImpl: async () =>
          jsonResponse(200, { ok: true, mode: "live", txHash, escrowAddress: retired }),
      })
      expect(client.waitForTransactionReceipt).not.toHaveBeenCalled()
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.code).toBe("retired_or_superseded_address")
      expect(result.presentation.main).toBe("The refund service used a retired escrow. Check the transaction before you try again.")
      expect(result.presentation.main.toLowerCase()).not.toContain("nothing was sent")
      expect(result.presentation.link?.href).toBe(relayerTxUrl(txHash))
      expect(result.presentation.detail).toBe("Details: 200 retired_or_superseded_address")
    }
  })
})

describe("relayer button", () => {
  it("hides the relayer when the URL is unset and when the action is not an escrow", () => {
    expect(
      relayerButtonModel({
        url: null,
        health: "ok",
        phase: "idle",
        gate: { ok: true },
        action: "dispute",
      }).visible,
    ).toBe(false)
    expect(
      relayerButtonModel({
        url: relayerUrl,
        health: "ok",
        phase: "idle",
        gate: { ok: true },
        action: "openDispute",
      }).visible,
    ).toBe(false)
    expect(
      relayerButtonModel({
        url: relayerUrl,
        health: "ok",
        phase: "idle",
        gate: { ok: true },
        action: "createEscrow",
      }).visible,
    ).toBe(false)
    expect(
      relayerButtonModel({
        url: relayerUrl,
        health: "ok",
        phase: "idle",
        gate: { ok: true },
        action: "dispute",
      }).visible,
    ).toBe(false)
    expect(
      relayerButtonModel({
        url: relayerUrl,
        health: "ok",
        phase: "idle",
        gate: { ok: true },
        action: "release",
      }).visible,
    ).toBe(false)
  })

  it("enables the button only when health is ok, and explains checking, down, and paused", () => {
    const checking = relayerButtonModel({
      url: relayerUrl,
      health: "unknown",
      phase: "idle",
      gate: { ok: true },
      action: "refund",
    })
    expect(checking).toMatchObject({ visible: true, disabled: true, note: RELAYER_CHECKING_NOTE })
    const down = relayerButtonModel({
      url: relayerUrl,
      health: "down",
      phase: "idle",
      gate: { ok: true },
      action: "refund",
    })
    expect(down).toMatchObject({ visible: true, disabled: true, note: RELAYER_DOWN_NOTE })
    const paused = relayerButtonModel({
      url: relayerUrl,
      health: "paused",
      phase: "idle",
      gate: { ok: true },
      action: "refund",
    })
    expect(paused).toMatchObject({ visible: true, disabled: true, note: RELAYER_PAUSED_NOTE })
    const ready = relayerButtonModel({
      url: relayerUrl,
      health: "ok",
      phase: "idle",
      gate: { ok: true },
      action: "refund",
    })
    expect(ready).toMatchObject({ visible: true, disabled: false, label: "Submit refund request", note: null })
  })

  it("disables the button while submitting and while waiting for confirmation", () => {
    const submitting = relayerButtonModel({
      url: relayerUrl,
      health: "ok",
      phase: "submitting",
      gate: { ok: true },
      action: "refund",
    })
    const waiting = relayerButtonModel({
      url: relayerUrl,
      health: "ok",
      phase: "confirming",
      gate: { ok: true },
      action: "refund",
    })
    expect(submitting).toMatchObject({ disabled: true, label: "Submitting the refund request…" })
    expect(waiting).toMatchObject({ disabled: true, label: "Waiting for confirmation…" })
  })
})

describe("relayer health", () => {
  let warn!: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
  })

  afterEach(() => {
    warn.mockRestore()
    vi.useRealTimers()
  })

  it("reads the kill switch from /health without credentials or extra headers", async () => {
    let target = ""
    let init: RequestInit | undefined
    const paused = await readRelayerPaused({
      url: `${relayerUrl}/`,
      fetchImpl: async (url, next) => {
        target = String(url)
        init = next
        return jsonResponse(200, { ok: true, killSwitch: true })
      },
    })
    expect(paused).toBe(true)
    expect(target).toBe(`${relayerUrl}/health`)
    expect(init?.method).toBe("GET")
    expect(init?.headers).toBeUndefined()
    expect(init?.credentials).toBeUndefined()
    expect(init?.body).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
    const open = await readRelayerPaused({
      url: relayerUrl,
      fetchImpl: async () => jsonResponse(200, { ok: true, killSwitch: false }),
    })
    expect(open).toBe(false)
    const health = await readRelayerHealth({
      url: relayerUrl,
      fetchImpl: async () => jsonResponse(200, { ok: true, killSwitch: false }),
    })
    expect(health.state).toBe("ok")
    expect(health.cause).toBeUndefined()
  })

  it("logs one line for each health failure cause and wakes on timeout, network or CORS, or 502, 503, 504", async () => {
    const secret = "super-secret-token"
    const cases: Array<{ name: string; run: () => Promise<void>; cause: string; status: string; wakes: boolean }> = [
      {
        name: "http",
        cause: "http_status",
        status: "500",
        wakes: false,
        run: async () => {
          const report = await readRelayerHealth({
            url: relayerUrl,
            fetchImpl: async () => jsonResponse(500, { ok: false }),
          })
          expect(report.status).toBe(500)
        },
      },
      {
        name: "wake-502",
        cause: "http_status",
        status: "502",
        wakes: true,
        run: async () => {
          const report = await readRelayerHealth({
            url: relayerUrl,
            fetchImpl: async () => jsonResponse(502, {}),
          })
          expect(relayerHealthWakes(report)).toBe(true)
        },
      },
      {
        name: "wake-http",
        cause: "http_status",
        status: "503",
        wakes: true,
        run: async () => {
          const report = await readRelayerHealth({
            url: relayerUrl,
            fetchImpl: async () => jsonResponse(503, "nope"),
          })
          expect(relayerHealthWakes(report)).toBe(true)
          expect(report.status).toBe(503)
        },
      },
      {
        name: "wake-504",
        cause: "http_status",
        status: "504",
        wakes: true,
        run: async () => {
          const report = await readRelayerHealth({
            url: relayerUrl,
            fetchImpl: async () => jsonResponse(504, {}),
          })
          expect(relayerHealthWakes(report)).toBe(true)
        },
      },
      {
        name: "network",
        cause: "network_or_cors",
        status: "none",
        wakes: true,
        run: async () => {
          const report = await readRelayerHealth({
            url: relayerUrl,
            fetchImpl: async () => {
              throw new TypeError("Failed to fetch")
            },
          })
          expect(relayerHealthWakes(report)).toBe(true)
        },
      },
      {
        name: "opaque",
        cause: "network_or_cors",
        status: "none",
        wakes: true,
        run: async () => {
          const report = await readRelayerHealth({
            url: relayerUrl,
            fetchImpl: async () =>
              ({
                ok: false,
                status: 0,
                type: "opaque",
                text: async () => "",
              }) as Response,
          })
          expect(report.cause).toBe("network_or_cors")
          expect(report.status).toBeUndefined()
          expect(relayerHealthWakes(report)).toBe(true)
        },
      },
      {
        name: "timeout",
        cause: "timeout",
        status: "none",
        wakes: true,
        run: async () => {
          vi.useFakeTimers()
          const pending = readRelayerHealth({
            url: relayerUrl,
            timeoutMs: 10_000,
            fetchImpl: () => new Promise(() => undefined),
          })
          const finished = pending.then((report) => report)
          await vi.advanceTimersByTimeAsync(10_000)
          const report = await finished
          expect(report.cause).toBe("timeout")
          expect(report.elapsedMs).toBeGreaterThanOrEqual(8_000)
          expect(relayerHealthWakes(report)).toBe(true)
          vi.useRealTimers()
        },
      },
      {
        name: "bad-body",
        cause: "bad_body",
        status: "200",
        wakes: false,
        run: async () => {
          const report = await readRelayerHealth({
            url: relayerUrl,
            fetchImpl: async () => jsonResponse(200, { ok: true }),
          })
          expect(report.cause).toBe("bad_body")
        },
      },
      {
        name: "not-ok",
        cause: "not_ok",
        status: "200",
        wakes: false,
        run: async () => {
          const report = await readRelayerHealth({
            url: relayerUrl,
            fetchImpl: async () => jsonResponse(200, { ok: false, killSwitch: false }),
          })
          expect(report.cause).toBe("not_ok")
        },
      },
    ]
    for (const item of cases) {
      warn.mockClear()
      await item.run()
      expect(warn).toHaveBeenCalledTimes(1)
      const line = String(warn.mock.calls[0]?.[0])
      expect(line).toMatch(new RegExp(`^refund health cause=${item.cause} status=${item.status} elapsedMs=\\d+$`))
      expect(line).not.toContain(secret)
      expect(line).not.toContain(relayerUrl)
      expect(line).not.toContain("0x")
      expect(line).not.toMatch(/authorization/i)
      expect(line.toLowerCase()).not.toContain("cookie")
    }
    const badUrl = await readRelayerHealth({ url: "not a url", fetchImpl: async () => jsonResponse(200, { ok: true }) })
    expect(badUrl.cause).toBe("bad_body")
    expect(relayerHealthWakes(badUrl)).toBe(false)
  })

  it("spaces wake checks by about 4s, stops at 60s, and never posts", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-11T12:00:00Z"))
    const calls: string[] = []
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push(`${init?.method ?? ""} ${String(url)}`)
      expect(init?.headers).toBeUndefined()
      expect(init?.credentials).toBeUndefined()
      return jsonResponse(502, { ok: false })
    }
    const phases: string[] = []
    const done = watchRelayerHealth({
      url: relayerUrl,
      fetchImpl,
      onUpdate: (update) => phases.push(update.phase),
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(RELAYER_HEALTH_RETRY_MS - 1)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(RELAYER_HEALTH_WAKE_CAP_MS)
    await done
    expect(phases.at(-1)).toBe("gave_up")
    expect(phases.every((phase) => phase === "waking" || phase === "gave_up")).toBe(true)
    expect(calls.every((call) => call.startsWith("GET ") && call.endsWith("/health"))).toBe(true)
    expect(calls.some((call) => call.includes("/v1/claims"))).toBe(false)
    const starts = calls.length
    expect(starts).toBe(Math.ceil(RELAYER_HEALTH_WAKE_CAP_MS / RELAYER_HEALTH_RETRY_MS))
  })

  it("shows a waking cold start then accepts a later ok without another post", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-11T12:00:00Z"))
    let attempt = 0
    const fetchImpl: typeof fetch = (_url, init) => {
      attempt += 1
      expect(init?.method).toBe("GET")
      if (attempt === 1) return new Promise(() => undefined)
      return Promise.resolve(jsonResponse(200, { ok: true, killSwitch: false }))
    }
    const phases: string[] = []
    const done = watchRelayerHealth({
      url: relayerUrl,
      fetchImpl,
      onUpdate: (update) => phases.push(update.phase),
    })
    await vi.advanceTimersByTimeAsync(8_000)
    expect(phases).not.toContain("ok")
    await vi.advanceTimersByTimeAsync(RELAYER_HEALTH_TIMEOUT_MS - 8_000)
    expect(phases).toContain("waking")
    await vi.advanceTimersByTimeAsync(0)
    await done
    expect(phases.at(-1)).toBe("ok")
    expect(attempt).toBe(2)
  })

  it("ignores a health result after the watch is cancelled", async () => {
    vi.useFakeTimers()
    const pending: { resolve: ((response: Response) => void) | null } = { resolve: null }
    const fetchImpl: typeof fetch = () =>
      new Promise((resolve) => {
        pending.resolve = resolve
      })
    const controller = new AbortController()
    const phases: string[] = []
    const done = watchRelayerHealth({
      url: relayerUrl,
      fetchImpl,
      signal: controller.signal,
      onUpdate: (update) => phases.push(update.phase),
    })
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    pending.resolve?.(jsonResponse(200, { ok: true, killSwitch: false }))
    await done
    expect(phases).not.toContain("ok")
  })
})

describe("signed claim intent", () => {
  it("matches the relayer schema byte for byte and pins the ClaimIntent typehash", () => {
    const schema = JSON.parse(readFileSync(join(relayerPackage, "claimIntent.json"), "utf8")) as {
      domainName: string
      domainVersion: string
      primaryType: string
      typeString: string
      actions: string[]
      actionValues: { refund: number }
      refusedActions: { release: number }
      types: { ClaimIntent: { name: string; type: string }[] }
    }
    expect(schema.domainName).toBe(CLAIM_INTENT_DOMAIN_NAME)
    expect(schema.domainVersion).toBe(CLAIM_INTENT_DOMAIN_VERSION)
    expect(toHex(toBytes(CLAIM_INTENT_DOMAIN_NAME))).toBe("0x4167656e742d42562052656c61796572")
    expect(toBytes(CLAIM_INTENT_DOMAIN_NAME)).toHaveLength(16)
    expect(toHex(toBytes(schema.domainName))).toBe("0x4167656e742d42562052656c61796572")
    expect(
      hashDomain({
        domain: {
          name: CLAIM_INTENT_DOMAIN_NAME,
          version: CLAIM_INTENT_DOMAIN_VERSION,
          chainId: 84532n,
          verifyingContract: escrow,
        },
        types: {
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "version", type: "string" },
            { name: "chainId", type: "uint256" },
            { name: "verifyingContract", type: "address" },
          ],
        },
      }),
    ).toBe("0x25ac3f837af8762d4769d04a046e12858b0bbbd43683dd1e7e561d85030d8c64")
    expect(
      hashDomain({
        domain: {
          name: "AgentBV Claim Relayer",
          version: CLAIM_INTENT_DOMAIN_VERSION,
          chainId: 84532n,
          verifyingContract: escrow,
        },
        types: {
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "version", type: "string" },
            { name: "chainId", type: "uint256" },
            { name: "verifyingContract", type: "address" },
          ],
        },
      }),
    ).toBe("0x86ccc7c40c6ac58cd64d4005172763a6ffc8f862dd35436ee829cb9f98040a96")
    expect(schema.primaryType).toBe(CLAIM_INTENT_PRIMARY_TYPE)
    expect(schema.typeString).toBe(CLAIM_INTENT_TYPE_STRING)
    expect(schema.actions).toEqual([...CLAIM_INTENT_ACTIONS])
    expect(schema.actions).not.toContain("release")
    expect(schema.actionValues).toEqual(CLAIM_INTENT_ACTION_VALUES)
    expect(schema.refusedActions).toEqual(CLAIM_INTENT_REFUSED_ACTIONS)
    expect(CLAIM_INTENT_ACTION_VALUES.refund).toBe(1)
    expect(schema.types.ClaimIntent).toEqual(
      CLAIM_INTENT_TYPES.ClaimIntent.map((field) => ({ name: field.name, type: field.type })),
    )
    expect(keccak256(toBytes(CLAIM_INTENT_TYPE_STRING))).toBe(CLAIM_INTENT_TYPEHASH)
    expect(keccak256(toBytes(schema.typeString))).toBe(CLAIM_INTENT_TYPEHASH)
  })

  it("signs with the connected wallet and posts that signature to a mock relayer", async () => {
    const release = previewRefund(escrow, id)
    const order: string[] = []
    let posted = ""
    let headerNames: string[] = []
    const client = {
      call: vi.fn(async () => {
        order.push("simulate")
        return "0x"
      }),
      waitForTransactionReceipt: vi.fn(async () => ({ status: "success" as const })),
    }
    const result = await runRelayerSubmission({
      url: relayerUrl,
      preview: release,
      ...signerInput(async (args) => {
        order.push("sign")
        return payerAccount.signTypedData(args)
      }),
      client,
      nowSeconds: 1_780_000_000,
      nonce: 42n,
      fetchImpl: async (_url, init) => {
        order.push("post")
        posted = String(init?.body)
        headerNames = [...new Headers(init?.headers).keys()]
        return jsonResponse(200, { ok: true, mode: "live", txHash, escrowAddress: escrow })
      },
    })
    expect(order).toEqual(["simulate", "sign", "post"])
    expect(headerNames).not.toContain("x-claim-secret")
    const body = JSON.parse(posted) as SignedLiveClaim
    expect(body).not.toHaveProperty("calldata")
    expect(body.intent.action).toBe("refund")
    expect(body.intent.nonce).toBe("42")
    expect(body.intent.deadline).toBe(String(1_780_000_000 + 240))
    const recovered = await recoverTypedDataAddress({
      domain: {
        name: CLAIM_INTENT_DOMAIN_NAME,
        version: CLAIM_INTENT_DOMAIN_VERSION,
        chainId: 84532,
        verifyingContract: escrow,
      },
      types: CLAIM_INTENT_TYPES,
      primaryType: CLAIM_INTENT_PRIMARY_TYPE,
      message: {
        action: 1,
        escrowId: id,
        sender: payerAccount.address,
        nonce: 42n,
        deadline: BigInt(1_780_000_000 + 240),
      },
      signature: body.signature,
    })
    expect(recovered).toBe(payerAccount.address)
    expect(result).toEqual({ ok: true, txHash })
  })

  it("posts the signed deadline and nonce when the clock moves and nowSeconds is unset", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const startMs = 1_780_000_000_000
    vi.setSystemTime(startMs)
    let signed: ClaimSignArgs["message"] | undefined
    let posted = ""
    try {
      const result = await runRelayerSubmission({
        url: relayerUrl,
        preview: previewRefund(escrow, id),
        ...signerInput(async (args) => {
          signed = args.message
          const signature = await payerAccount.signTypedData(args)
          vi.setSystemTime(startMs + 5_000)
          return signature
        }),
        client: readyClient({ status: "success" }),
        fetchImpl: async (_url, init) => {
          posted = String(init?.body)
          return jsonResponse(200, { ok: true, mode: "live", txHash, escrowAddress: escrow })
        },
      })
      expect(signed).toBeDefined()
      if (!signed) return
      const body = JSON.parse(posted) as SignedLiveClaim
      expect(body.intent.deadline).toBe(signed.deadline.toString())
      expect(body.intent.nonce).toBe(signed.nonce.toString())
      expect(body.intent.escrowId).toBe(signed.escrowId)
      expect(body.intent.sender).toBe(signed.sender)
      const recovered = await recoverTypedDataAddress({
        domain: {
          name: CLAIM_INTENT_DOMAIN_NAME,
          version: CLAIM_INTENT_DOMAIN_VERSION,
          chainId: 84532,
          verifyingContract: escrow,
        },
        types: CLAIM_INTENT_TYPES,
        primaryType: CLAIM_INTENT_PRIMARY_TYPE,
        message: {
          action: signed.action,
          escrowId: signed.escrowId,
          sender: signed.sender,
          nonce: BigInt(body.intent.nonce),
          deadline: BigInt(body.intent.deadline),
        },
        signature: body.signature,
      })
      expect(recovered).toBe(payerAccount.address)
      expect(result).toEqual({ ok: true, txHash })
    } finally {
      vi.useRealTimers()
    }
  })
})
