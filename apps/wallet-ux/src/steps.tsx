import type { ReactNode } from "react"
import { chunkHex } from "./format"
import { FILLED_FROM_LINK } from "./routes"
import { ChunkedHex, CopyButton } from "./ui"

export function Stepper({ step, total }: { step: number; total: number }) {
  const dots = Array.from({ length: total }, (_, index) => (index < step ? "●" : "○")).join("")
  return (
    <div className="stepper" data-testid="stepper">
      <p data-testid="step-count">
        Step {step} of {total}
      </p>
      <p className="step-dots" aria-hidden="true">
        {dots}
      </p>
    </div>
  )
}

export function StepFooter({ onBack, children }: { onBack: () => void; children: ReactNode }) {
  return (
    <div className="step-footer">
      <button type="button" className="back-link" onClick={onBack}>
        Back
      </button>
      <div className="step-primary">{children}</div>
    </div>
  )
}

/** A value that arrived from the address bar. It is shown, not edited, and it does not submit. */
export function FilledFromLink({ label, value, testId = "filled-from-link" }: { label: string; value: string; testId?: string }) {
  return (
    <div className="readonly-card" data-testid={testId}>
      <div className="kv-label">{label}</div>
      <div className="kv-value">
        <ChunkedHex parts={chunkHex(value)} />
        <CopyButton value={value} />
      </div>
      <p className="hint">{FILLED_FROM_LINK}</p>
    </div>
  )
}

export function ReadonlyValue({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="readonly-card" data-testid={testId}>
      <div className="kv-label">{label}</div>
      <div className="kv-value">{value}</div>
      <p className="hint">Read from the escrow.</p>
    </div>
  )
}
