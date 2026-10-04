import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import {
  createPublicClient,
  decodeFunctionData,
  encodeFunctionResult,
  http,
  toFunctionSelector,
  type Address,
  type Hex,
  type PublicClient,
} from "viem"
import { afterEach, describe, expect, it } from "vitest"
import { escrowAbi } from "./abi"
import { ADDRESSES } from "./addresses"
import {
  OPEN_ESCROW_STATE,
  disputeWindowMessage,
  readDisputeSubject,
  type DisputeSubjectClient,
} from "./disputeSubject"
import { panelSubject } from "./preview"
import { FORM_ERRORS } from "./submit"

const bookedEscrow = ADDRESSES.botAttestationEscrow
if (!bookedEscrow) throw new Error("The address book has no booked escrow.")
const escrow: Address = bookedEscrow
const otherEscrow = "0x2222222222222222222222222222222222222222" as Address
const escrowId = `0x${"ab".repeat(32)}` as Hex
const createdAt = 1_700_000_000n
const expiresAt = createdAt + 86_400n
const now = createdAt + 10n
const viewSubject = `0x${"11".repeat(32)}` as Hex
const code = "0x60016000" as Hex
const escrowsSelector = toFunctionSelector("escrows(bytes32)")
const panelSelector = toFunctionSelector("panelSubject(bytes32,uint256)")

type RpcFault =
  | { type: "status"; status: number }
  | { type: "reset" }
  | { type: "hang" }
  | { type: "text" }
  | { type: "rpc"; code: number; message: string; data?: Hex }

type RpcSetup = {
  code?: Hex
  escrowFault?: RpcFault
  subjectFault?: RpcFault
  subjectResult?: Hex
  createdAt?: bigint
  expiresAt?: bigint
  state?: number
}

const servers: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  const open = servers.splice(0)
  await Promise.all(open.map((entry) => entry.close()))
})

function escrowWord(setup: RpcSetup): Hex {
  return encodeFunctionResult({
    abi: escrowAbi,
    functionName: "escrows",
    result: [
      escrow,
      escrow,
      escrowId,
      escrowId,
      1n,
      setup.createdAt ?? createdAt,
      setup.expiresAt ?? expiresAt,
      setup.state ?? OPEN_ESCROW_STATE,
      `0x${"00".repeat(32)}`,
      "0x0000000000000000000000000000000000000000" as Address,
    ],
  })
}

function subjectWord(setup: RpcSetup): Hex {
  if (setup.subjectResult) return setup.subjectResult
  return encodeFunctionResult({
    abi: escrowAbi,
    functionName: "panelSubject",
    result: viewSubject,
  })
}

function sendFault(req: IncomingMessage, res: ServerResponse, id: number | string | null, fault: RpcFault) {
  if (fault.type === "reset") {
    req.socket.destroy()
    return
  }
  if (fault.type === "hang") return
  if (fault.type === "text") {
    res.writeHead(200, { "content-type": "text/plain" })
    res.end("not json")
    return
  }
  if (fault.type === "status") {
    res.writeHead(fault.status, { "content-type": "application/json" })
    res.end(JSON.stringify({ jsonrpc: "2.0", id, result: null }))
    return
  }
  const error: { code: number; message: string; data?: Hex } = { code: fault.code, message: fault.message }
  if (fault.data !== undefined) error.data = fault.data
  res.writeHead(200, { "content-type": "application/json" })
  res.end(JSON.stringify({ jsonrpc: "2.0", id, error }))
}

async function startRpc(setup: RpcSetup) {
  const hits = { escrow: 0, subject: 0, subjectData: [] as Hex[] }
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk) => chunks.push(chunk))
    req.on("end", () => {
      let body: { id?: number | string | null; method?: string; params?: [{ data?: string }] }
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof body
      } catch {
        res.writeHead(400)
        res.end("bad")
        return
      }
      const id = body.id ?? 1
      const reply = (result: string) => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result }))
      }
      if (body.method === "eth_getCode") {
        reply(setup.code ?? code)
        return
      }
      if (body.method === "eth_call") {
        const data = body.params?.[0]?.data ?? "0x"
        const selector = data.slice(0, 10).toLowerCase()
        if (selector === escrowsSelector) {
          hits.escrow += 1
          if (setup.escrowFault) {
            sendFault(req, res, id, setup.escrowFault)
            return
          }
          reply(escrowWord(setup))
          return
        }
        if (selector === panelSelector) {
          hits.subject += 1
          hits.subjectData.push(data as Hex)
          if (setup.subjectFault) {
            sendFault(req, res, id, setup.subjectFault)
            return
          }
          reply(subjectWord(setup))
          return
        }
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const address = server.address() as AddressInfo
  const entry = {
    url: `http://127.0.0.1:${address.port}`,
    hits,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
  servers.push(entry)
  return entry
}

function clientFor(url: string, timeout = 20_000): DisputeSubjectClient {
  const publicClient: PublicClient = createPublicClient({
    transport: http(url, { timeout, retryCount: 0 }),
  })
  return {
    getCode: (args) => publicClient.getCode(args),
    call: (args) => publicClient.call(args),
    readContract: (args) => publicClient.readContract(args),
  }
}

const networkFaults: RpcFault[] = [
  { type: "status", status: 500 },
  { type: "status", status: 502 },
  { type: "status", status: 429 },
  { type: "reset" },
  { type: "text" },
  { type: "rpc", code: -32603, message: "Internal error" },
  { type: "rpc", code: -32005, message: "limit exceeded" },
  { type: "rpc", code: -32000, message: "header not found" },
]

const emptyReverts: RpcFault[] = [
  { type: "rpc", code: 3, message: "execution reverted" },
  { type: "rpc", code: 3, message: "execution reverted", data: "0x" },
  { type: "rpc", code: -32000, message: "execution reverted" },
  { type: "rpc", code: -32000, message: "execution reverted", data: "0x" },
]

describe("dispute subject", () => {
  it("uses the on-chain subject as returned, even when it differs from the local hash", async () => {
    const rpc = await startRpc({})
    const result = await readDisputeSubject(clientFor(rpc.url), escrow, escrowId, now)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toBe("view")
    expect(result.subject).toBe(viewSubject)
    expect(result.createdAt).toBe(createdAt)
    expect(result.expiresAt).toBe(expiresAt)
    expect(result.state).toBe(OPEN_ESCROW_STATE)
    expect(result.subject).not.toBe(escrowId)
    expect(result.subject).not.toBe(panelSubject(escrow, escrowId, createdAt))
    expect(rpc.hits.subject).toBe(1)
    const decoded = decodeFunctionData({ abi: escrowAbi, data: rpc.hits.subjectData[0] ?? "0x" })
    expect(decoded.functionName).toBe("panelSubject")
    expect(decoded.args).toEqual([escrowId, createdAt])
  })

  it("keeps a network failure on the subject call from falling back", async () => {
    expect(FORM_ERRORS.subjectNetwork).toBe("The network did not answer, so this dispute was not prepared.")
    for (const fault of networkFaults) {
      const rpc = await startRpc({ subjectFault: fault })
      const result = await readDisputeSubject(clientFor(rpc.url), escrow, escrowId, now)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.message).toBe(FORM_ERRORS.subjectNetwork)
    }
  })

  it("keeps a client timeout on the subject call from falling back", async () => {
    const rpc = await startRpc({ subjectFault: { type: "hang" } })
    const result = await readDisputeSubject(clientFor(rpc.url, 200), escrow, escrowId, now)
    expect(result).toEqual({ ok: false, message: FORM_ERRORS.subjectNetwork })
  })

  it("falls back to the claim identifier only for an empty revert on the booked escrow", async () => {
    for (const fault of emptyReverts) {
      const rpc = await startRpc({ subjectFault: fault })
      const result = await readDisputeSubject(clientFor(rpc.url), escrow, escrowId, now)
      expect(result).toEqual({
        ok: true,
        escrowId,
        subject: escrowId,
        createdAt,
        expiresAt,
        state: OPEN_ESCROW_STATE,
        source: "escrow-id",
      })
      const mixed = await startRpc({ subjectFault: fault })
      const cased = await readDisputeSubject(clientFor(mixed.url), escrow.toLowerCase() as Address, escrowId, now)
      expect(cased).toEqual({
        ok: true,
        escrowId,
        subject: escrowId,
        createdAt,
        expiresAt,
        state: OPEN_ESCROW_STATE,
        source: "escrow-id",
      })
    }
  })

  it("rejects an empty revert on a coded address that is not the legacy escrow", async () => {
    expect(FORM_ERRORS.subjectNotBooked).toBe(
      "This contract did not return a dispute subject. It is not a supported escrow.",
    )
    for (const fault of emptyReverts) {
      const rpc = await startRpc({ subjectFault: fault })
      const result = await readDisputeSubject(clientFor(rpc.url), otherEscrow, escrowId, now)
      expect(result).toEqual({ ok: false, message: FORM_ERRORS.subjectNotBooked })
    }
  })

  it("shows the network copy when the escrow read fails in transport", async () => {
    for (const fault of networkFaults) {
      const rpc = await startRpc({ escrowFault: fault })
      const result = await readDisputeSubject(clientFor(rpc.url), escrow, escrowId, now)
      expect(result).toEqual({ ok: false, message: FORM_ERRORS.subjectNetwork })
      expect(rpc.hits.subject).toBe(0)
    }
    const hung = await startRpc({ escrowFault: { type: "hang" } })
    const timedOut = await readDisputeSubject(clientFor(hung.url, 200), escrow, escrowId, now)
    expect(timedOut).toEqual({ ok: false, message: FORM_ERRORS.subjectNetwork })
    expect(hung.hits.subject).toBe(0)
  })

  it("treats a real getCode of 0x as no contract", async () => {
    expect(FORM_ERRORS.subjectNoCode).toBe("No escrow contract at this address on this network.")
    const rpc = await startRpc({ code: "0x" })
    const result = await readDisputeSubject(clientFor(rpc.url), escrow, escrowId, now)
    expect(result).toEqual({ ok: false, message: FORM_ERRORS.subjectNoCode })
    expect(rpc.hits.escrow).toBe(0)
    expect(rpc.hits.subject).toBe(0)
  })

  it("blocks a non-empty revert and a return that is not 32 bytes", async () => {
    const reverted = await startRpc({
      subjectFault: { type: "rpc", code: 3, message: "execution reverted", data: "0x08c379a0" },
    })
    expect(await readDisputeSubject(clientFor(reverted.url), escrow, escrowId, now)).toEqual({
      ok: false,
      message: FORM_ERRORS.subjectRejected,
    })

    for (const data of ["0x", "0x1234", `0x${"ab".repeat(31)}`, `0x${"ab".repeat(40)}`] as const) {
      const rpc = await startRpc({ subjectResult: data })
      expect(await readDisputeSubject(clientFor(rpc.url), escrow, escrowId, now)).toEqual({
        ok: false,
        message: FORM_ERRORS.subjectRejected,
      })
    }

    const missing = await startRpc({ createdAt: 0n, expiresAt: 0n, state: OPEN_ESCROW_STATE })
    const absent = await readDisputeSubject(clientFor(missing.url), escrow, escrowId, now)
    expect(absent).toEqual({ ok: false, message: FORM_ERRORS.subjectMissing })
    expect(missing.hits.subject).toBe(0)
  })

  it("blocks a dispute that the contract would reject, and allows an open claim inside the window", async () => {
    expect(disputeWindowMessage(OPEN_ESCROW_STATE, expiresAt, expiresAt)).toBeNull()
    expect(disputeWindowMessage(OPEN_ESCROW_STATE, expiresAt, expiresAt + 1n)).toBe(FORM_ERRORS.subjectExpired)
    expect(disputeWindowMessage(3, expiresAt, now)).toBe(FORM_ERRORS.subjectNotOpen)

    const open = await startRpc({ state: OPEN_ESCROW_STATE, expiresAt, createdAt })
    const allowed = await readDisputeSubject(clientFor(open.url), escrow, escrowId, expiresAt)
    expect(allowed.ok).toBe(true)
    if (allowed.ok) expect(allowed.source).toBe("view")

    const expired = await startRpc({ state: OPEN_ESCROW_STATE, expiresAt, createdAt })
    expect(await readDisputeSubject(clientFor(expired.url), escrow, escrowId, expiresAt + 1n)).toEqual({
      ok: false,
      message: FORM_ERRORS.subjectExpired,
    })
    expect(expired.hits.subject).toBe(0)

    const disputed = await startRpc({ state: 3, expiresAt, createdAt })
    expect(await readDisputeSubject(clientFor(disputed.url), escrow, escrowId, now)).toEqual({
      ok: false,
      message: FORM_ERRORS.subjectNotOpen,
    })
    expect(disputed.hits.subject).toBe(0)
  })
})
