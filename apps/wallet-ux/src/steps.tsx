import type { ReactNode } from "react"
import { chunkHex } from "./format"
import { FILLED_FROM_LINK } from "./routes"
import { ChunkedHex, CopyButton } from "./ui"

export function Stepper({ step, total }: { step: number; total: number }) {
  return (
    <div className="stepper" data-testid="stepper">
      <p data-testid="step-count">
        Step {step} of {total}
      </p>
      <ol className="step-dots">
        {Array.from({ length: total }, (_, index) => {
          const n = index + 1
          const state = n < step ? "done" : n === step ? "current" : "upcoming"
          const mark = state === "done" ? "✓" : state === "current" ? "●" : "○"
          const word = state === "done" ? "Done" : state === "current" ? "Now" : "Later"
          return (
            <li key={n} className={`step-dot ${state}`} aria-current={state === "current" ? "step" : undefined}>
              <span className="step-dot-mark" aria-hidden="true">
                {mark}
              </span>
              <span className="step-dot-word">
                {word} {n}
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

export function StepFooter({ onBack, children }: { onBack: () => void; children: ReactNode }) {
  return (
    <div className="step-actions">
      <button type="button" className="back-button" onClick={onBack}>
        Back
      </button>
      <div className="step-primary">{children}</div>
    </div>
  )
}

export function IdRow({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="kv-row" data-testid={testId}>
      <div className="kv-label">{label}</div>
      <div className="kv-value">
        <ChunkedHex parts={chunkHex(value)} />
        <CopyButton value={value} />
      </div>
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
