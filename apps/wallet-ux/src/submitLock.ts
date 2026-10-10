import { useEffect, useId, useSyncExternalStore } from "react"

let holder: string | null = null
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Take the single in-flight transaction slot. A second caller is refused. */
export function tryHoldSubmit(id: string): boolean {
  if (holder !== null && holder !== id) return false
  holder = id
  emit()
  return true
}

export function releaseSubmit(id: string) {
  if (holder !== id) return
  holder = null
  emit()
}

/** True when some other submit already holds the in-flight slot. */
export function useSubmitBlocked(active: boolean): { id: string; blocked: boolean } {
  const id = useId()
  const blocked = useSyncExternalStore(
    subscribe,
    () => holder !== null && holder !== id,
    () => false,
  )
  useEffect(() => {
    if (active) tryHoldSubmit(id)
    else releaseSubmit(id)
    return () => releaseSubmit(id)
  }, [active, id])
  return { id, blocked }
}
