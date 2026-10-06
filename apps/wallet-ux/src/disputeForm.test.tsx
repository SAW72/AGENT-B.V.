// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { encodeFunctionResult, decodeFunctionData, type Address, type Hex } from "viem"
import { afterEach, describe, expect, it, vi } from "vitest"
import { escrowAbi } from "./abi"
import { FlowPreview } from "./FlowPreview"
import { FILE_DISPUTE_TEXT } from "./preview"
import { FORM_ERRORS } from "./submit"

const escrow = "0x3d660502D75f1e97b08c110255921b437A3C4C42" as Address
const panel = "0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb" as Address
const claim = `0x${"ab".repeat(32)}` as Hex
const subject = `0x${"11".repeat(32)}` as Hex
const createdAt = 1_700_000_000n
const expiresAt = 4_000_000_000n

vi.mock("wagmi", () => ({
  useAccount: () => ({ isConnected: false, address: undefined, connector: undefined, chainId: undefined }),
  usePublicClient: () => ({
    getCode: async () => "0x60016000",
    readContract: async () => [
      escrow,
      escrow,
      claim,
      claim,
      1n,
      createdAt,
      expiresAt,
      0,
      `0x${"00".repeat(32)}`,
      "0x0000000000000000000000000000000000000000",
    ],
    call: async () => ({
      data: encodeFunctionResult({ abi: escrowAbi, functionName: "panelSubject", result: subject }),
    }),
  }),
  useSendTransaction: () => ({ sendTransactionAsync: vi.fn(), isPending: false }),
  useWalletClient: () => ({ data: undefined }),
}))

afterEach(() => {
  cleanup()
})

describe("dispute form", () => {
  it("prepares one dispute call with a fresh random id and a reason", async () => {
    render(<FlowPreview escrow={escrow} panel={panel} />)

    expect(screen.queryByRole("heading", { name: "Link a dispute" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Prepare this dispute link" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Prepare opening and linking" })).toBeNull()
    expect(screen.getByText(FILE_DISPUTE_TEXT)).toBeTruthy()
    expect(FILE_DISPUTE_TEXT).not.toMatch(/then link/i)

    const form = document.getElementById("open-dispute")
    if (!form) throw new Error("missing dispute form")
    const dispute = within(form)
    const caseId = dispute.getByLabelText("Case identifier") as HTMLInputElement
    expect(caseId.readOnly).toBe(true)
    expect(caseId.value).toMatch(/^0x[0-9a-f]{64}$/)
    const firstId = caseId.value

    fireEvent.click(dispute.getByRole("button", { name: "Generate a new identifier" }))
    expect(caseId.value).toMatch(/^0x[0-9a-f]{64}$/)
    expect(caseId.value).not.toBe(firstId)

    fireEvent.click(dispute.getByRole("button", { name: "Prepare this dispute" }))
    expect(screen.getByRole("alert").textContent).toBe(FORM_ERRORS.openIds)

    fireEvent.change(dispute.getByLabelText("Reason"), { target: { value: "late delivery" } })
    fireEvent.click(dispute.getByRole("button", { name: "Prepare this dispute" }))
    expect(screen.getByRole("alert").textContent).toBe(FORM_ERRORS.openIds)

    fireEvent.change(dispute.getByLabelText("Claim identifier"), { target: { value: claim } })
    await waitFor(() => {
      expect((dispute.getByLabelText("Subject") as HTMLInputElement).value).toBe(subject)
    })

    fireEvent.click(dispute.getByRole("button", { name: "Prepare this dispute" }))
    const previews = screen.getAllByTestId("calldata-preview")
    expect(previews).toHaveLength(1)
    expect(screen.queryByTestId("open-and-link")).toBeNull()
    expect(screen.queryByRole("heading", { name: "Open the case" })).toBeNull()
    expect(screen.queryByRole("heading", { name: "Link the case" })).toBeNull()

    const calldata = previews[0]?.querySelector("pre")?.textContent ?? ""
    const decoded = decodeFunctionData({ abi: escrowAbi, data: calldata as Hex })
    expect(decoded.functionName).toBe("dispute")
    expect(decoded.args).toEqual([claim, caseId.value, "late delivery"])
    expect(previews[0]?.textContent).toContain(escrow)
    expect(previews[0]?.textContent).not.toContain(panel)
  })
})
