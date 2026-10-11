import { useEffect, useRef, useState, type FormEvent } from "react"
import type { Address } from "viem"
import { useAccount, usePublicClient } from "wagmi"
import { disputePanelAbi } from "./abi"
import { BASE_SEPOLIA_CHAIN_ID } from "./addresses"
import { WALLET_SIGNED_TEST_LINE } from "./brand"
import { isZeroBytes32, parseBytes32 } from "./bytes32"
import { ActionButton, ActionStatus, DISPUTE_ID_HINT, DISPUTE_ID_LABEL } from "./actionButton"
import { CONTRACT_LABELS, GAS_FEE_TEXT, PREPARE_FIRST_REASON, VOTE_SEAT_REASON } from "./actionProgress"
import { readUrlBytes32, useCarriedIds, useSyncedPrefill } from "./carriedIds"
import { shortAddress } from "./format"
import { prepareFailure, usePrepareSession, yieldPrepareTick } from "./prepareFeedback"
import { previewVote, type CallPreview } from "./preview"
import { preparedMatches } from "./pendingTx"
import { usePreparedRouteGuard } from "./prepareFeedback"
import { flowHref, historyAllowsStep, navigate, replaceRoute, shownStep, type WalletRoute } from "./routes"
import { FORM_ERRORS, previewCardCopy } from "./submit"
import { FilledFromLink, IdRow, StepFooter, Stepper } from "./steps"
import { AddressRow, CalldataDetails, LabeledChunks } from "./ui"
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
  hint,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  hint?: string
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} value={value} spellCheck={false} autoComplete="off" onChange={(event) => onChange(event.target.value)} />
      {hint ? <p className="hint">{hint}</p> : null}
    </div>
  )
}

export type VoteSeat = "loading" | "yes" | "no" | "unreadable"

export function voteTaskReason(seat: VoteSeat, address?: Address): string | null {
  if (seat === "yes" || seat === "loading") return null
  const who = address ? `Connected: ${shortAddress(address)}.` : "No wallet is connected."
  return `${VOTE_SEAT_REASON} ${who}`
}

export function useVoteSeat(panel: Address): VoteSeat {
  const account = useAccount()
  const client = usePublicClient({ chainId: BASE_SEPOLIA_CHAIN_ID })
  const [seat, setSeat] = useState<VoteSeat>("loading")
  useEffect(() => {
    const accountAddress = account.address
    if (!account.isConnected || !accountAddress) {
      setSeat("no")
      return
    }
    if (!client) {
      setSeat("unreadable")
      return
    }
    let cancelled = false
    setSeat("loading")
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
          setSeat(typeof value === "boolean" ? (value ? "yes" : "no") : "unreadable")
        },
        () => {
          if (!cancelled) setSeat("unreadable")
        },
      )
    return () => {
      cancelled = true
    }
  }, [account.address, account.isConnected, client, panel])
  return seat
}

function caseBlockMessage(read: CaseRead): string | null {
  if (read.status === "unreadable") return CASE_UNREADABLE_TEXT
  if (read.status === "missing") return NO_DISPUTE_TEXT
  if (read.status === "resolved") return resolvedCaseText(read.row.dealStands)
  if (read.status === "already-voted") return ALREADY_VOTED_TEXT
  if (read.status === "vote-unreadable") return VOTED_UNREADABLE_TEXT
  return null
}

export function VoteScreen({ panel, route = null }: { panel: Address; route?: WalletRoute | null }) {
  const guided = route?.flow === "vote" ? route : null
  const account = useAccount()
  const client = usePublicClient({ chainId: BASE_SEPOLIA_CHAIN_ID })
  const carried = useCarriedIds()
  const [urlDispute] = useState(() => readUrlBytes32("dispute"))
  const prefill = useSyncedPrefill(guided?.dispute.value, urlDispute.value ?? "")
  const setDisputeId = prefill.setValue
  const touched = prefill.touched
  const setTouched = prefill.setTouched
  const disputeLink = guided?.dispute.value ?? null
  const disputeId = disputeLink != null && !touched ? disputeLink : prefill.value
  const [choice, setChoice] = useState<"" | "payee" | "payer">("")
  const [arbitrator, setArbitrator] = useState<ArbitratorRead>("loading")
  const [caseRead, setCaseRead] = useState<CaseRead>({ status: "idle" })
  const [generation, setGeneration] = useState(0)
  const [voteStatus, setVoteStatus] = useState<HTMLElement | null>(null)
  const session = usePrepareSession<CallPreview>("vote", null)
  const parsedId = parseBytes32(disputeId)
  const caseRef = useRef<CaseRead>({ status: "idle" })
  const caseFlight = useRef<Promise<void> | null>(null)
  const disputeIdRef = useRef(disputeId)
  const choiceRef = useRef(choice)
  const arbitratorRef = useRef(arbitrator)
  disputeIdRef.current = disputeId
  choiceRef.current = choice
  arbitratorRef.current = arbitrator

  useEffect(() => {
    if (touched || guided?.dispute.value || !carried.disputeId) return
    if (carried.disputeId === disputeIdRef.current) return
    setDisputeId(carried.disputeId)
    session.clear()
  }, [carried.disputeId, guided?.dispute.value, setDisputeId, touched])

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
      caseFlight.current = null
      caseRef.current = { status: "idle" }
      setCaseRead({ status: "idle" })
      return
    }
    if (!client) {
      caseFlight.current = null
      caseRef.current = { status: "unreadable" }
      setCaseRead({ status: "unreadable" })
      return
    }
    const disputeIdHex = parsedId
    const accountAddress = account.isConnected ? account.address : undefined
    let cancelled = false
    setCaseRead((current) => {
      const next =
        current.status === "open" ||
        current.status === "resolved" ||
        current.status === "already-voted" ||
        current.status === "vote-unreadable"
          ? current
          : ({ status: "loading" } as const)
      caseRef.current = next
      return next
    })
    const apply = (next: CaseRead) => {
      if (cancelled) return
      caseRef.current = next
      setCaseRead(next)
    }
    const flight = (async () => {
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
        apply({ status: "unreadable" })
        return
      }
      if (row.createdAt === 0n) {
        apply({ status: "missing" })
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
        apply({ status: "resolved", ...detail })
        return
      }
      if (alreadyVoted === "unreadable") {
        apply({ status: "vote-unreadable", ...detail })
        return
      }
      if (alreadyVoted === true) {
        apply({ status: "already-voted", ...detail })
        return
      }
      apply({ status: "open", ...detail })
    })()
    caseFlight.current = flight
    return () => {
      cancelled = true
    }
  }, [account.address, account.isConnected, Boolean(client), generation, panel, parsedId])

  const caseBlocks =
    parsedId != null &&
    (caseRead.status === "unreadable" ||
      caseRead.status === "missing" ||
      caseRead.status === "resolved" ||
      caseRead.status === "already-voted" ||
      caseRead.status === "vote-unreadable")
  const canPrepare = arbitrator === "yes" && !caseBlocks

  async function settleCase() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const flight = caseFlight.current
      if (!flight) return
      await flight
      if (caseFlight.current === flight) return
    }
  }

  const routeStep = guided?.step ?? 1
  const voteHex = parseBytes32(disputeId)
  const voteReady =
    voteHex != null &&
    session.preview != null &&
    preparedMatches(session.preview.calldata, { action: "vote", disputeId: voteHex })
  const voteGuard = usePreparedRouteGuard(session.clear, `vote|${voteHex ?? ""}|${routeStep}`)
  const step = guided ? shownStep(routeStep, 2, voteGuard.allowed || historyAllowsStep(), voteReady) : 1
  const linked = disputeLink != null && !touched
  const seatReason = voteTaskReason(arbitrator === "yes" || arbitrator === "loading" ? "yes" : arbitrator, account.address)

  async function onSubmit(event?: FormEvent): Promise<boolean> {
    event?.preventDefault()
    if (arbitratorRef.current !== "yes" || caseBlockMessage(caseRef.current)) return false
    if (!session.begin()) return false
    try {
      await yieldPrepareTick()
      await settleCase()
      const blocked = caseBlockMessage(caseRef.current)
      if (arbitratorRef.current !== "yes" || blocked) {
        if (blocked) session.publish(blocked, null)
        return false
      }
      const id = parseBytes32(disputeIdRef.current)
      if (!id) {
        session.publish(FORM_ERRORS.voteId, null)
        return false
      }
      if (isZeroBytes32(id)) {
        session.publish(FORM_ERRORS.zeroDisputeId, null)
        return false
      }
      const selected = choiceRef.current
      if (selected !== "payee" && selected !== "payer") {
        session.publish(FORM_ERRORS.voteChoice, null)
        return false
      }
      session.publish(null, previewVote(panel, id, selected === "payee"))
      return true
    } catch (cause) {
      session.publish(prepareFailure("vote", cause), null)
      return false
    } finally {
      session.finish()
    }
  }

  function go(next: number, allowStep = false) {
    if (!guided) return
    const params = new URLSearchParams()
    if (guided.dispute.value) params.set("dispute", guided.dispute.value)
    if (next > 1) params.set("step", String(next))
    const search = params.toString()
    navigate(search ? `/vote?${search}` : "/vote", { allowStep })
  }

  function back() {
    if (!guided) return
    if (guided.step > 1) go(guided.step - 1, true)
    else navigate("/")
  }

  async function onNext() {
    const ok = await onSubmit()
    if (ok) {
      const id = parseBytes32(disputeIdRef.current)
      voteGuard.arm(`vote|${id ?? ""}|2`)
      go(2, true)
    }
  }

  useEffect(() => {
    if (!guided || routeStep <= 1 || step !== 1) return
    replaceRoute(flowHref("vote", 1, { dispute: voteHex }))
  }, [guided, routeStep, step, voteHex])

  const arbitratorMessage =
    arbitrator === "loading"
      ? ARBITRATOR_READING_TEXT
      : arbitrator === "unreadable"
        ? ARBITRATOR_UNREADABLE_TEXT
        : arbitrator === "no"
          ? NOT_ARBITRATOR_TEXT
          : null

  if (guided) {
    const voteLead =
      choice === "payee"
        ? "You are voting that the deal stands. The payee gets paid."
        : choice === "payer"
          ? "You are voting to undo the deal. The payer gets refunded."
          : "You are casting an arbitrator vote on this dispute."
    const nextBlocked = !canPrepare || (caseRead.status === "loading" && parsedId != null)
    return (
      <section className="card guided-flow" aria-labelledby="vote-heading" data-testid="vote-screen">
        <Stepper step={step} total={2} />
        <h2 id="vote-heading">{VOTE_HEADING}</h2>
        <p data-testid="vote-test-only">{WALLET_SIGNED_TEST_LINE}</p>
        {guided.stepNotice ? (
          <p className="banner" role="status" data-testid="url-step-notice">
            {guided.stepNotice}
          </p>
        ) : null}
        {guided.dispute.notice ? (
          <p className="banner" role="status" data-testid="url-dispute-notice">
            {guided.dispute.notice}
          </p>
        ) : null}
        {seatReason ? (
          <p className="action-reason" role="status" data-testid="vote-seat-reason">
            {seatReason}
          </p>
        ) : null}
        {step === 1 ? (
          <form
            id="vote-form"
            onSubmit={(event) => {
              event.preventDefault()
              void onNext()
            }}
          >
            <p className="muted">{VOTE_MUTED}</p>
            <AddressRow label="Agent-BV dispute panel" value={panel} testId="vote-panel" />
            {arbitratorMessage && !seatReason ? (
              <p role="status" data-testid="vote-arbitrator">
                {arbitratorMessage}
              </p>
            ) : null}
            <CaseStatus read={caseRead} />
            {linked && guided.dispute.value ? (
              <>
                <FilledFromLink label={DISPUTE_ID_LABEL} value={guided.dispute.value} testId="vote-filled" />
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setTouched(true)
                    setDisputeId("")
                    session.clear()
                  }}
                >
                  Use a different id
                </button>
              </>
            ) : (
              <Field
                id="vote-dispute-id"
                label={DISPUTE_ID_LABEL}
                hint={DISPUTE_ID_HINT}
                value={disputeId}
                onChange={(value) => {
                  setTouched(true)
                  setDisputeId(value)
                  session.clear()
                }}
              />
            )}
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
                    session.clear()
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
                    session.clear()
                  }}
                />
                {UNDO_DEAL_LABEL}
              </label>
            </fieldset>
            <StepFooter onBack={back}>
              <ActionButton
                type="button"
                disabled={session.preparing || nextBlocked}
                reason={
                  canPrepare || seatReason
                    ? null
                    : (caseBlockMessage(caseRead) ?? "This vote is not available yet.")
                }
                onClick={() => void onNext()}
                state={session.preparing ? { status: "busy", label: "Preparing…" } : { status: "idle", label: "Next" }}
              />
            </StepFooter>
            {session.error ? <ActionStatus state={{ status: "error", message: session.error }} nodeRef={session.setNode} /> : null}
          </form>
        ) : voteReady && session.preview ? (
          <div data-testid="review-step">
            <div className="preview" data-testid="vote-preview" tabIndex={-1} aria-label="Prepared vote" ref={session.setNode}>
              <p data-testid="review-plain">{voteLead}</p>
              <p data-testid="review-contract">{CONTRACT_LABELS.panel}</p>
              <LabeledChunks label="Contract" address={session.preview.to} testId="review-contract-address" />
              <IdRow label={DISPUTE_ID_LABEL} value={voteHex ?? ""} testId="review-id" />
              <p data-testid="review-gas">{GAS_FEE_TEXT}</p>
              <CalldataDetails calldata={session.preview.calldata} />
            </div>
            <div ref={setVoteStatus} />
            <StepFooter onBack={back}>
              <WalletOnlySubmit
                key={session.preview.calldata}
                preview={session.preview}
                allowed={[panel]}
                hold={!canPrepare}
                guided
                statusRoot={voteStatus}
                onConfirmed={() => setGeneration((value) => value + 1)}
              />
            </StepFooter>
          </div>
        ) : null}
      </section>
    )
  }

  return (
    <section className="card" aria-labelledby="vote-heading" data-testid="vote-screen">
      <h2 id="vote-heading">{VOTE_HEADING}</h2>
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
      <form id="vote-form" onSubmit={(event) => void onSubmit(event)}>
        {urlDispute.notice ? (
          <p className="banner" role="status" data-testid="url-dispute-notice">
            {urlDispute.notice}
          </p>
        ) : null}
        <Field
          id="vote-dispute-id"
          label={DISPUTE_ID_LABEL}
          hint={DISPUTE_ID_HINT}
          value={disputeId}
          onChange={(value) => {
            setTouched(true)
            setDisputeId(value)
            session.clear()
          }}
        />
        <button
          type="button"
          className="secondary"
          onClick={() => {
            setTouched(true)
            setDisputeId("")
            session.clear()
          }}
        >
          Use my own
        </button>
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
                session.clear()
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
                session.clear()
              }}
            />
            {UNDO_DEAL_LABEL}
          </label>
        </fieldset>
        <ActionButton
          type="submit"
          disabled={session.preparing || !canPrepare}
          reason={
            canPrepare
              ? null
              : arbitrator === "loading"
                ? ARBITRATOR_READING_TEXT
                : arbitrator === "unreadable"
                  ? ARBITRATOR_UNREADABLE_TEXT
                  : arbitrator !== "yes"
                    ? VOTE_SEAT_REASON
                    : (caseBlockMessage(caseRead) ?? "This vote is not available yet.")
          }
          state={session.preparing ? { status: "busy", label: "Preparing…" } : { status: "idle", label: "Prepare this vote" }}
        />
        {session.error ? (
          <ActionStatus state={{ status: "error", message: session.error }} nodeRef={session.setNode} />
        ) : session.preview ? (
          <div className="preview" data-testid="vote-preview" tabIndex={-1} aria-label="Prepared vote" ref={session.setNode}>
            <p>{previewCardCopy(session.preview.functionName, false)}</p>
            <p data-testid="review-contract">{CONTRACT_LABELS.panel}</p>
            <LabeledChunks label="Contract" address={session.preview.to} testId="review-contract-address" />
            <p data-testid="review-gas">{GAS_FEE_TEXT}</p>
            <CalldataDetails calldata={session.preview.calldata} />
            <WalletOnlySubmit
              key={session.preview.calldata}
              preview={session.preview}
              allowed={[panel]}
              hold={!canPrepare}
              onConfirmed={() => setGeneration((value) => value + 1)}
            />
          </div>
        ) : null}
      </form>
      {session.preview ? null : (
        <ActionButton
          testId="vote-submit-blocked"
          disabled
          reason={PREPARE_FIRST_REASON}
          state={{ status: "idle", label: "Submit on Base Sepolia" }}
        />
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
