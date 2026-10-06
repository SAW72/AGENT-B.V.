import { useEffect, useState, type FormEvent } from "react"
import { formatEther, type Address } from "viem"
import { useAccount, usePublicClient } from "wagmi"
import { disputePanelAbi } from "./abi"
import { BASE_SEPOLIA_CHAIN_ID } from "./addresses"
import { TESTNET_LINE, WALLET_SIGNED_TEST_LINE } from "./brand"
import { parseBytes32 } from "./bytes32"
import { previewVote, type CallPreview } from "./preview"
import { FORM_ERRORS, previewCardCopy } from "./submit"
import { AddressRow } from "./ui"
import {
  ALREADY_VOTED_TEXT,
  ARBITRATOR_READING_TEXT,
  ARBITRATOR_UNREADABLE_TEXT,
  CASE_READING_TEXT,
  CASE_UNREADABLE_TEXT,
  DEAL_STANDS_LABEL,
  NO_DISPUTE_TEXT,
  NOT_ARBITRATOR_TEXT,
  PANEL_SIZE_UNREADABLE_TEXT,
  UNDO_DEAL_LABEL,
  VOTE_HEADING,
  VOTE_MUTED,
  VOTE_NOTE,
  VOTED_UNREADABLE_TEXT,
  parseDisputeRow,
  resolvedCaseText,
  voteTallyText,
  type DisputeRow,
} from "./walletCopy"
import { WalletOnlySubmit } from "./WalletOnlySubmit"

type ArbitratorRead = "loading" | "yes" | "no" | "unreadable"

type CaseRead =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "unreadable" }
  | { status: "missing" }
  | {
      status: "open" | "already-voted" | "vote-unreadable" | "resolved"
      row: DisputeRow
      panelSize: bigint | null
      panelSizeUnreadable: boolean
    }

function Field({
  id,
  label,
  value,
  onChange,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} value={value} spellCheck={false} autoComplete="off" onChange={(event) => onChange(event.target.value)} />
    </div>
  )
}

export function VoteScreen({ panel }: { panel: Address }) {
  const account = useAccount()
  const client = usePublicClient({ chainId: BASE_SEPOLIA_CHAIN_ID })
  const [disputeId, setDisputeId] = useState("")
  const [choice, setChoice] = useState<"" | "payee" | "payer">("")
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<CallPreview | null>(null)
  const [arbitrator, setArbitrator] = useState<ArbitratorRead>("loading")
  const [caseRead, setCaseRead] = useState<CaseRead>({ status: "idle" })
  const [generation, setGeneration] = useState(0)
  const parsedId = parseBytes32(disputeId)

  useEffect(() => {
    const accountAddress = account.address
    if (!account.isConnected || !accountAddress) {
      setArbitrator("no")
      return
    }
    if (!client) {
      setArbitrator("unreadable")
      return
    }
    let cancelled = false
    setArbitrator("loading")
    void client
      .readContract({
        address: panel,
        abi: disputePanelAbi,
        functionName: "isArbitrator",
        args: [accountAddress],
      })
      .then(
        (value) => {
          if (cancelled) return
          if (typeof value === "boolean") setArbitrator(value ? "yes" : "no")
          else setArbitrator("unreadable")
        },
        () => {
          if (!cancelled) setArbitrator("unreadable")
        },
      )
    return () => {
      cancelled = true
    }
  }, [account.address, account.isConnected, client, generation, panel])

  useEffect(() => {
    if (!parsedId) {
      setCaseRead({ status: "idle" })
      return
    }
    if (!client) {
      setCaseRead({ status: "unreadable" })
      return
    }
    const disputeIdHex = parsedId
    const accountAddress = account.isConnected ? account.address : undefined
    let cancelled = false
    setCaseRead((current) =>
      current.status === "open" ||
      current.status === "resolved" ||
      current.status === "already-voted" ||
      current.status === "vote-unreadable"
        ? current
        : { status: "loading" },
    )
    void (async () => {
      let row: DisputeRow | null = null
      let rowFailed = false
      try {
        const value = await client.readContract({
          address: panel,
          abi: disputePanelAbi,
          functionName: "disputes",
          args: [disputeIdHex],
        })
        row = parseDisputeRow(value)
        if (!row) rowFailed = true
      } catch {
        rowFailed = true
      }
      if (cancelled) return
      if (rowFailed || !row) {
        setCaseRead({ status: "unreadable" })
        return
      }
      if (row.createdAt === 0n) {
        setCaseRead({ status: "missing" })
        return
      }

      let panelSize: bigint | null = null
      let panelSizeUnreadable = false
      try {
        const value = await client.readContract({
          address: panel,
          abi: disputePanelAbi,
          functionName: "PANEL_SIZE",
        })
        if (typeof value === "bigint") panelSize = value
        else panelSizeUnreadable = true
      } catch {
        panelSizeUnreadable = true
      }
      if (cancelled) return

      let alreadyVoted: boolean | "unreadable" | "skipped" = "skipped"
      if (accountAddress) {
        try {
          const value = await client.readContract({
            address: panel,
            abi: disputePanelAbi,
            functionName: "voted",
            args: [disputeIdHex, accountAddress],
          })
          alreadyVoted = typeof value === "boolean" ? value : "unreadable"
        } catch {
          alreadyVoted = "unreadable"
        }
      }
      if (cancelled) return

      const detail = { row, panelSize, panelSizeUnreadable }
      if (row.resolved) {
        setCaseRead({ status: "resolved", ...detail })
        return
      }
      if (alreadyVoted === "unreadable") {
        setCaseRead({ status: "vote-unreadable", ...detail })
        return
      }
      if (alreadyVoted === true) {
        setCaseRead({ status: "already-voted", ...detail })
        return
      }
      setCaseRead({ status: "open", ...detail })
    })()
    return () => {
      cancelled = true
    }
  }, [account.address, account.isConnected, client, generation, panel, parsedId])

  const caseBlocks =
    parsedId != null &&
    (caseRead.status === "loading" ||
      caseRead.status === "unreadable" ||
      caseRead.status === "missing" ||
      caseRead.status === "resolved" ||
      caseRead.status === "already-voted" ||
      caseRead.status === "vote-unreadable")
  const canPrepare = arbitrator === "yes" && !caseBlocks

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (!canPrepare) return
    const id = parseBytes32(disputeId)
    if (!id) {
      setPreview(null)
      setError(FORM_ERRORS.voteId)
      return
    }
    if (choice !== "payee" && choice !== "payer") {
      setPreview(null)
      setError(FORM_ERRORS.voteChoice)
      return
    }
    setError(null)
    setPreview(previewVote(panel, id, choice === "payee"))
  }

  const arbitratorMessage =
    arbitrator === "loading"
      ? ARBITRATOR_READING_TEXT
      : arbitrator === "unreadable"
        ? ARBITRATOR_UNREADABLE_TEXT
        : arbitrator === "no"
          ? NOT_ARBITRATOR_TEXT
          : null

  return (
    <section className="card" aria-labelledby="vote-heading" data-testid="vote-screen">
      <h2 id="vote-heading" className="heading-with-pill">
        <span>{VOTE_HEADING}</span>
        <span className="pill info" data-testid="vote-testnet-pill">
          {TESTNET_LINE}
        </span>
      </h2>
      <p data-testid="vote-test-only">{WALLET_SIGNED_TEST_LINE}</p>
      <p className="muted">{VOTE_MUTED}</p>
      <p data-testid="vote-note">{VOTE_NOTE}</p>
      <AddressRow label="Agent-BV dispute panel" value={panel} testId="vote-panel" />
      {arbitratorMessage ? (
        <p role="status" data-testid="vote-arbitrator">
          {arbitratorMessage}
        </p>
      ) : null}
      <CaseStatus read={caseRead} />
      <form id="vote-form" onSubmit={onSubmit}>
        <Field
          id="vote-dispute-id"
          label="Dispute identifier"
          value={disputeId}
          onChange={(value) => {
            setDisputeId(value)
            setPreview(null)
            setError(null)
          }}
        />
        <fieldset className="choice">
          <legend>Who gets the money</legend>
          <label>
            <input
              type="radio"
              name="vote-support"
              value="payee"
              checked={choice === "payee"}
              onChange={() => {
                setChoice("payee")
                setPreview(null)
                setError(null)
              }}
            />
            {DEAL_STANDS_LABEL}
          </label>
          <label>
            <input
              type="radio"
              name="vote-support"
              value="payer"
              checked={choice === "payer"}
              onChange={() => {
                setChoice("payer")
                setPreview(null)
                setError(null)
              }}
            />
            {UNDO_DEAL_LABEL}
          </label>
        </fieldset>
        <button type="submit" disabled={!canPrepare}>
          Prepare this vote
        </button>
      </form>
      {error ? (
        <p className="bad" role="alert">
          {error}
        </p>
      ) : null}
      {preview ? (
        <div className="preview" data-testid="vote-preview">
          <p>{previewCardCopy(preview.functionName, false)}</p>
          <p className="mono">{preview.to}</p>
          <p>value {formatEther(preview.valueWei)} ETH</p>
          <pre className="calldata">{preview.calldata}</pre>
          <WalletOnlySubmit
            key={preview.calldata}
            preview={preview}
            allowed={[panel]}
            hold={!canPrepare}
            onConfirmed={() => setGeneration((value) => value + 1)}
          />
        </div>
      ) : (
        <button type="button" data-testid="vote-submit-blocked" disabled>
          Submit on Base Sepolia
        </button>
      )}
    </section>
  )
}

function CaseStatus({ read }: { read: CaseRead }) {
  if (read.status === "idle") return null
  if (read.status === "loading") {
    return (
      <p role="status" data-testid="vote-case">
        {CASE_READING_TEXT}
      </p>
    )
  }
  if (read.status === "unreadable") {
    return (
      <p role="status" data-testid="vote-case">
        {CASE_UNREADABLE_TEXT}
      </p>
    )
  }
  if (read.status === "missing") {
    return (
      <p role="status" data-testid="vote-case">
        {NO_DISPUTE_TEXT}
      </p>
    )
  }

  const tally = voteTallyText(read.row.votesFor, read.row.votesAgainst, read.panelSize)
  const block =
    read.status === "resolved"
      ? resolvedCaseText(read.row.dealStands)
      : read.status === "already-voted"
        ? ALREADY_VOTED_TEXT
        : read.status === "vote-unreadable"
          ? VOTED_UNREADABLE_TEXT
          : null

  return (
    <>
      <p role="status" data-testid="vote-tally">
        {tally}
      </p>
      {read.panelSizeUnreadable ? (
        <p role="status" data-testid="vote-panel-size">
          {PANEL_SIZE_UNREADABLE_TEXT}
        </p>
      ) : null}
      {block ? (
        <p role="status" data-testid="vote-case">
          {block}
        </p>
      ) : null}
    </>
  )
}
