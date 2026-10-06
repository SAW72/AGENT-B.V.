import { useState, type FormEvent } from "react"
import { formatEther, type Address } from "viem"
import { TESTNET_LINE, WALLET_SIGNED_TEST_LINE } from "./brand"
import { parseBytes32 } from "./bytes32"
import { previewVote, type CallPreview } from "./preview"
import { FORM_ERRORS, previewCardCopy } from "./submit"
import { AddressRow } from "./ui"
import { WalletOnlySubmit } from "./WalletOnlySubmit"

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
  const [disputeId, setDisputeId] = useState("")
  const [support, setSupport] = useState<"" | "uphold" | "against">("")
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<CallPreview | null>(null)

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    const id = parseBytes32(disputeId)
    if (!id) {
      setPreview(null)
      setError(FORM_ERRORS.voteId)
      return
    }
    if (support !== "uphold" && support !== "against") {
      setPreview(null)
      setError(FORM_ERRORS.voteChoice)
      return
    }
    setError(null)
    setPreview(previewVote(panel, id, support === "uphold"))
  }

  return (
    <section className="card" aria-labelledby="vote-heading" data-testid="vote-screen">
      <h2 id="vote-heading" className="heading-with-pill">
        <span>Vote</span>
        <span className="pill info" data-testid="vote-testnet-pill">
          {TESTNET_LINE}
        </span>
      </h2>
      <p data-testid="vote-test-only">{WALLET_SIGNED_TEST_LINE}</p>
      <p className="muted">
        Only an allowlisted arbitrator can vote. Uphold keeps the original decision. Against votes the other way. The
        connected wallet signs this. This page does not ask for a private key or a recovery phrase.
      </p>
      <AddressRow label="Dispute panel" value={panel} testId="vote-panel" />
      <form id="vote-form" onSubmit={onSubmit}>
        <Field id="vote-dispute-id" label="Dispute identifier" value={disputeId} onChange={setDisputeId} />
        <fieldset className="choice">
          <legend>Decision</legend>
          <label>
            <input
              type="radio"
              name="vote-support"
              value="uphold"
              checked={support === "uphold"}
              onChange={() => setSupport("uphold")}
            />
            Uphold the original decision
          </label>
          <label>
            <input
              type="radio"
              name="vote-support"
              value="against"
              checked={support === "against"}
              onChange={() => setSupport("against")}
            />
            Vote against the original decision
          </label>
        </fieldset>
        <button type="submit">Prepare this vote</button>
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
          <WalletOnlySubmit key={preview.calldata} preview={preview} allowed={[panel]} />
        </div>
      ) : null}
    </section>
  )
}
