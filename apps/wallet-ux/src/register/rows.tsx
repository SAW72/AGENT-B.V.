import { useEffect, useRef, useState, type ReactNode } from "react"
import { ErrorNotice } from "../ErrorNotice"
import {
  BACK,
  COPY_FAILED,
  COPY_LABEL,
  COPIED_LABEL,
  LABEL_PROVISIONAL_ID,
  PROVISIONAL_LABEL,
  registerErrorView,
  registerNoticeView,
} from "../registerCopy"
import type { ParsedRegistration, RegisterErrorCode, RegisterUiNotice } from "./types"

export function KvRow({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="kv-row">
      <div className="kv-label">{label}</div>
      <div className="kv-value" data-testid={testId}>
        {children}
      </div>
    </div>
  )
}

export function ProvisionalRow({ id }: { id: string }) {
  if (id === "") return null
  return (
    <div className="kv-row" data-testid="provisional-row">
      <div className="kv-label">{LABEL_PROVISIONAL_ID}</div>
      <div className="kv-value">
        <span className="mono register-hex" data-testid="provisional-id">
          {id}
        </span>
        <span className="pill draft" data-testid="provisional-label">
          {PROVISIONAL_LABEL}
        </span>
      </div>
    </div>
  )
}

export function StepActions({
  showBack,
  onBack,
  children,
}: {
  showBack: boolean
  onBack: () => void
  children: ReactNode
}) {
  return (
    <div className="step-actions">
      {showBack ? (
        <button type="button" className="back-button" onClick={onBack}>
          {BACK}
        </button>
      ) : null}
      <div className="step-primary">{children}</div>
    </div>
  )
}

export function CopyTextButton({ value, testId = "copy-text" }: { value: string; testId?: string }) {
  const [label, setLabel] = useState(COPY_LABEL)
  const timer = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (timer.current != null) window.clearTimeout(timer.current)
    }
  }, [])

  return (
    <button
      type="button"
      className="secondary"
      data-testid={testId}
      onClick={() => {
        const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
        if (clipboard == null || typeof clipboard.writeText !== "function") {
          setLabel(COPY_FAILED)
          return
        }
        void clipboard.writeText(value).then(
          () => {
            setLabel(COPIED_LABEL)
            if (timer.current != null) window.clearTimeout(timer.current)
            timer.current = window.setTimeout(() => setLabel(COPY_LABEL), 1200)
          },
          () => setLabel(COPY_FAILED),
        )
      }}
    >
      {label}
    </button>
  )
}

export function RegisterAlerts({
  errorKind,
  errorDetail,
  notice,
  noticeDetail,
  parsed,
  hideError,
}: {
  errorKind: RegisterErrorCode | null
  errorDetail: string | null
  notice: RegisterUiNotice | null
  noticeDetail: string | null
  parsed: ParsedRegistration | null
  hideError?: boolean
}) {
  const note = registerNoticeView(notice, noticeDetail)
  const error = hideError ? null : registerErrorView(errorKind, errorDetail, parsed)
  return (
    <>
      {note ? <ErrorNotice main={note.main} detail={note.detail} /> : null}
      {error ? <ErrorNotice main={error.main} detail={error.detail} /> : null}
    </>
  )
}
