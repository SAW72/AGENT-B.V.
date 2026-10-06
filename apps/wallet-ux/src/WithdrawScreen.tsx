import { useEffect, useState, type FormEvent } from "react"
import { formatEther, getAddress, isAddress, type Address } from "viem"
import { useAccount, usePublicClient } from "wagmi"
import { escrowAbi } from "./abi"
import { BASE_SEPOLIA_CHAIN_ID } from "./addresses"
import { TESTNET_LINE, WALLET_SIGNED_TEST_LINE } from "./brand"
import { formatEth } from "./format"
import { previewWithdraw, previewWithdrawTo, type CallPreview } from "./preview"
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

function TestnetHeading() {
  return (
    <>
      <h2 id="withdraw-heading" className="heading-with-pill">
        <span>Withdraw</span>
        <span className="pill info" data-testid="withdraw-testnet-pill">
          {TESTNET_LINE}
        </span>
      </h2>
      <p data-testid="withdraw-test-only">{WALLET_SIGNED_TEST_LINE}</p>
    </>
  )
}

export function WithdrawScreen({
  escrow,
  readsEnabled,
}: {
  escrow: Address | null
  readsEnabled: boolean
}) {
  if (escrow == null) {
    return (
      <section className="card" aria-labelledby="withdraw-heading" data-testid="withdraw-screen">
        <TestnetHeading />
        <div className="empty" data-testid="withdraw-empty" role="status">
          <strong>Not deployed on Sepolia yet.</strong>
          <p>The escrow address is empty. There is no credit to withdraw.</p>
        </div>
      </section>
    )
  }

  return (
    <section className="card" aria-labelledby="withdraw-heading" data-testid="withdraw-screen">
      <TestnetHeading />
      <p className="muted">
        This pulls the connected wallet's own credit back to that wallet, or to a destination that can accept it. The
        connected wallet signs this. This page does not ask for a private key or a recovery phrase.
      </p>
      <WithdrawForm escrow={escrow} readsEnabled={readsEnabled} />
    </section>
  )
}

function WithdrawForm({ escrow, readsEnabled }: { escrow: Address; readsEnabled: boolean }) {
  const account = useAccount()
  const client = usePublicClient({ chainId: BASE_SEPOLIA_CHAIN_ID })
  const [destination, setDestination] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<CallPreview | null>(null)
  const [credit, setCredit] = useState<bigint | null>(null)
  const [creditUnreadable, setCreditUnreadable] = useState(false)

  useEffect(() => {
    const accountAddress = account.address
    if (!readsEnabled || !accountAddress || !client) {
      setCredit(null)
      setCreditUnreadable(false)
      return
    }
    let cancelled = false
    setCredit(null)
    setCreditUnreadable(false)
    void client
      .readContract({
        address: escrow,
        abi: escrowAbi,
        functionName: "pendingWithdrawals",
        args: [accountAddress],
      })
      .then(
        (value) => {
          if (cancelled) return
          if (typeof value === "bigint") setCredit(value)
          else setCreditUnreadable(true)
        },
        () => {
          if (!cancelled) setCreditUnreadable(true)
        },
      )
    return () => {
      cancelled = true
    }
  }, [account.address, client, escrow, readsEnabled])

  function show(next: CallPreview) {
    setError(null)
    setPreview(next)
  }

  function onWithdraw(event: FormEvent) {
    event.preventDefault()
    show(previewWithdraw(escrow))
  }

  function onWithdrawTo(event: FormEvent) {
    event.preventDefault()
    const entered = destination.trim()
    if (!isAddress(entered)) {
      setPreview(null)
      setError(FORM_ERRORS.withdrawDestination)
      return
    }
    show(previewWithdrawTo(escrow, getAddress(entered)))
  }

  const creditText = !account.isConnected
    ? "Connect a wallet on Base Sepolia to read its credit."
    : !readsEnabled
      ? "Credit stays hidden while reads are refused."
      : creditUnreadable
        ? "This wallet's credit could not be read."
        : credit == null
          ? "Reading this wallet's credit."
          : `Credit available to this wallet: ${formatEth(credit)}`

  return (
    <>
      <AddressRow label="Escrow" value={escrow} testId="withdraw-escrow" />
      <p data-testid="withdraw-credit">{creditText}</p>
      <form id="withdraw-form" onSubmit={onWithdraw}>
        <button type="submit">Prepare withdraw</button>
      </form>
      <form id="withdraw-to-form" onSubmit={onWithdrawTo}>
        <Field id="withdraw-destination" label="Destination wallet" value={destination} onChange={setDestination} />
        <button type="submit">Prepare withdraw to this address</button>
      </form>
      {error ? (
        <p className="bad" role="alert">
          {error}
        </p>
      ) : null}
      {preview ? (
        <div className="preview" data-testid="withdraw-preview">
          <p>{previewCardCopy(preview.functionName, false)}</p>
          <p className="mono">{preview.to}</p>
          <p>value {formatEther(preview.valueWei)} ETH</p>
          <pre className="calldata">{preview.calldata}</pre>
          <WalletOnlySubmit key={preview.calldata} preview={preview} allowed={[escrow]} />
        </div>
      ) : null}
    </>
  )
}
