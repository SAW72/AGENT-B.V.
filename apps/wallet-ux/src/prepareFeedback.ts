import { useCallback, useEffect, useRef, useState } from "react"
import { presentError } from "./format"

/** Shown on the clicked Prepare button while its result is still being built. */
export const PREPARING_LABEL = "Preparing…"

export function prepareFailure(action: string, cause: unknown): string {
  return `Couldn't prepare this ${action}: ${presentError(cause).main}`
}

/** One macrotask so the busy label can paint before synchronous work finishes. */
export function yieldPrepareTick(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0)
  })
}

export function revealResult(node: HTMLElement | null): void {
  if (!node) return
  if (typeof node.scrollIntoView === "function") {
    node.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }
  node.focus()
}

/**
 * Owns the busy flag, the result, and the focus token for one Prepare button.
 * `active` names which sibling form last prepared. A different active form clears
 * this result so a stale preview cannot linger under another form.
 */
export function usePrepareSession<T>(slot: string, active: string | null) {
  const [preparing, setPreparing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<T | null>(null)
  const [reveal, setReveal] = useState(0)
  const preparingRef = useRef(false)
  const nodeRef = useRef<HTMLElement | null>(null)

  const setNode = useCallback((node: HTMLElement | null) => {
    nodeRef.current = node
  }, [])

  useEffect(() => {
    if (reveal === 0) return
    revealResult(nodeRef.current)
  }, [reveal])

  useEffect(() => {
    if (active != null && active !== slot) {
      setError(null)
      setPreview(null)
    }
  }, [active, slot])

  function begin(): boolean {
    if (preparingRef.current) return false
    preparingRef.current = true
    setPreparing(true)
    return true
  }

  function publish(nextError: string | null, nextPreview: T | null) {
    setError(nextError)
    setPreview(nextPreview)
    setReveal((value) => value + 1)
  }

  function clear() {
    setError(null)
    setPreview(null)
  }

  function finish() {
    preparingRef.current = false
    setPreparing(false)
  }

  return { preparing, error, preview, setNode, begin, publish, clear, finish }
}
