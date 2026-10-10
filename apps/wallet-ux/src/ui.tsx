import { Fragment, useState } from "react"
import { chunkAddress, isZeroAddress, sameAddress, shortAddress } from "./format"

export function explorerUrl(address: string): string {
  return `https://sepolia.basescan.org/address/${address}`
}

export function ChunkedHex({ parts }: { parts: string[] }) {
  return (
    <span className="chunked">
      {parts.map((part, index) => (
        <Fragment key={`${index}-${part}`}>
          {index > 0 ? " " : null}
          <span className="chunk">{part}</span>
        </Fragment>
      ))}
    </span>
  )
}

export function LabeledChunks({ label, address, testId }: { label: string; address: string; testId: string }) {
  const { checksummed, parts } = chunkAddress(address)
  return (
    <div className="kv-row">
      <div className="kv-label">{label}</div>
      <div className="kv-value" data-testid={testId} data-address={checksummed}>
        <ChunkedHex parts={parts} />
        <CopyButton value={checksummed} />
      </div>
    </div>
  )
}

export function CalldataDetails({ calldata }: { calldata: string }) {
  return (
    <details className="calldata-details" data-testid="calldata-details">
      <summary>Details (raw transaction data)</summary>
      <pre className="calldata">{calldata}</pre>
    </details>
  )
}

export function CopyButton({ value }: { value: string }) {
  const [label, setLabel] = useState("Copy")

  return (
    <button
      type="button"
      className="secondary"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(
          () => {
            setLabel("Copied")
            window.setTimeout(() => setLabel("Copy"), 1200)
          },
          () => setLabel("Copy failed"),
        )
      }}
    >
      {label}
    </button>
  )
}

export function AddressRow({
  label,
  value,
  expected,
  pinName = "pin",
  testId,
}: {
  label: string
  value: string
  expected?: string
  /** What the expected address is, in plain words. Owner rows pass the book role. */
  pinName?: string
  testId?: string
}) {
  const checked = expected != null
  const mismatch = checked && !sameAddress(value, expected)
  return (
    <div className="kv-row">
      <div className="kv-label">{label}</div>
      <div className="kv-value">
        <span className="mono" title={value} data-testid={testId}>
          {shortAddress(value)}
        </span>
        {isZeroAddress(value) ? <span className="muted"> none</span> : null}
        {checked ? (
          <span className={mismatch ? "bad" : "pin-match"} data-testid={testId ? `${testId}-pin` : undefined}>
            {mismatch ? ` does not match ${pinName}` : ` matches ${pinName}`}
          </span>
        ) : null}
        <CopyButton value={value} />
        <a href={explorerUrl(value)} target="_blank" rel="noreferrer">
          View
        </a>
      </div>
    </div>
  )
}

export function TextRow({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="kv-row">
      <div className="kv-label">{label}</div>
      <div className="kv-value" data-testid={testId}>
        {value}
      </div>
    </div>
  )
}

export function NoteList({ notes }: { notes: string[] }) {
  if (notes.length === 0) return null
  return (
    <ul className="notes">
      {notes.map((note) => (
        <li key={note}>{note}</li>
      ))}
    </ul>
  )
}
