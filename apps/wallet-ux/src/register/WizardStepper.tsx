import { stepCount, WIZARD_STEP_LABELS } from "../registerCopy"
import type { WizardStep } from "./types"

export function WizardStepper({ step }: { step: WizardStep }) {
  return (
    <div className="stepper" data-testid="wizard-stepper">
      <p className="step-count">{stepCount(step)}</p>
      <ol className="step-dots">
        {WIZARD_STEP_LABELS.map((label, index) => {
          const n = (index + 1) as WizardStep
          const state = n < step ? "done" : n === step ? "current" : "upcoming"
          const mark = state === "done" ? "✓" : state === "current" ? "●" : "○"
          return (
            <li
              key={label}
              className={`step-dot ${state}`}
              data-step-state={state}
              aria-current={state === "current" ? "step" : undefined}
            >
              <span className="step-dot-mark" aria-hidden="true">
                {mark}
              </span>
              <span className="step-dot-word">{`${n} ${label}`}</span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
