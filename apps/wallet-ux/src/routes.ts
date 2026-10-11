import { useSyncExternalStore } from "react"
import { flushSync } from "react-dom"
import { parseBytes32 } from "./bytes32"
import { DISPUTE_URL_IGNORED, ESCROW_URL_IGNORED } from "./carriedIds"

export const FLOWS = ["fund", "release", "refund", "dispute", "vote", "withdraw"] as const

export type FlowId = (typeof FLOWS)[number]

/** Input steps plus Review. Sign, pending, and confirmed stay on the Review button. */
export const FLOW_STEPS: Record<FlowId, number> = {
  fund: 4,
  release: 2,
  refund: 2,
  dispute: 2,
  vote: 2,
  withdraw: 2,
}

export const STEP_IGNORED = "That step in the link was ignored."
export const PAGE_IGNORED = "That page in the link was ignored."
export const REVIEW_EMPTY = "Nothing was prepared from this link. Nothing will be sent until you review it and confirm."
export const FILLED_FROM_LINK = "Filled from link"

export type IdParam = { value: `0x${string}` | null; notice: string | null }

export type WalletRoute = {
  flow: FlowId | null
  step: number
  stepNotice: string | null
  pageNotice: string | null
  escrow: IdParam
  dispute: IdParam
}

const HOME: WalletRoute = {
  flow: null,
  step: 1,
  stepNotice: null,
  pageNotice: null,
  escrow: { value: null, notice: null },
  dispute: { value: null, notice: null },
}

function isFlow(value: string): value is FlowId {
  return (FLOWS as readonly string[]).includes(value)
}

function readId(params: URLSearchParams, name: "escrow" | "dispute"): IdParam {
  const raw = params.get(name)
  if (raw == null || raw.trim() === "") return { value: null, notice: null }
  const parsed = parseBytes32(raw)
  if (!parsed) return { value: null, notice: name === "escrow" ? ESCROW_URL_IGNORED : DISPUTE_URL_IGNORED }
  return { value: parsed, notice: null }
}

export function readWalletRoute(href = typeof window === "undefined" ? "http://localhost/" : window.location.href): WalletRoute {
  let url: URL
  try {
    url = new URL(href, "http://localhost")
  } catch {
    return { ...HOME, pageNotice: PAGE_IGNORED }
  }
  const escrow = readId(url.searchParams, "escrow")
  const dispute = readId(url.searchParams, "dispute")
  const parts = url.pathname.split("/").filter(Boolean)
  if (parts.length === 0) return { ...HOME, escrow, dispute }
  const head = parts[0]
  if (parts.length !== 1 || head == null || !isFlow(head)) {
    return { ...HOME, pageNotice: PAGE_IGNORED, escrow, dispute }
  }
  const flow = head
  const total = FLOW_STEPS[flow]
  const rawStep = url.searchParams.get("step")
  if (rawStep == null || rawStep === "") {
    return { flow, step: 1, stepNotice: null, pageNotice: null, escrow, dispute }
  }
  // Do not trim. `?step=+2` is decoded as a leading space, and that must not become step 2.
  if (!/^[1-9][0-9]*$/.test(rawStep) || Number(rawStep) > total) {
    return { flow, step: 1, stepNotice: STEP_IGNORED, pageNotice: null, escrow, dispute }
  }
  return { flow, step: Number(rawStep), stepNotice: null, pageNotice: null, escrow, dispute }
}

export function flowHref(
  flow: FlowId,
  step: number,
  query: { escrow?: string | null; dispute?: string | null } = {},
): string {
  const params = new URLSearchParams()
  if (query.escrow && flow !== "fund" && flow !== "vote" && flow !== "withdraw") params.set("escrow", query.escrow)
  if (query.dispute && flow === "vote") params.set("dispute", query.dispute)
  if (step > 1) params.set("step", String(step))
  const search = params.toString()
  return search ? `/${flow}?${search}` : `/${flow}`
}

/** Where a confirmed action sends the user, with the id that was actually sent. */
export function confirmedNext(
  action: string,
  subjectId: string | null,
): { href: string; label: string } | null {
  if (action === "createEscrow" && subjectId) {
    return { href: `/release?escrow=${subjectId}`, label: "Next: release the payment" }
  }
  if (action === "release" || action === "refund") return { href: "/withdraw", label: "Next: withdraw" }
  if (action === "dispute" && subjectId) return { href: `/vote?dispute=${subjectId}`, label: "Next: cast a vote" }
  if (action === "vote") return { href: "/release", label: "Next: release the payment" }
  return null
}

const listeners = new Set<() => void>()

function emitRoute() {
  if (listeners.size === 0) return
  // Flush so the screen matches the URL before navigate() returns. Callers
  // are click handlers and the popstate listener, never render itself.
  flushSync(() => {
    for (const listener of [...listeners]) listener()
  })
}

export function subscribeRoute(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function inputFocused(): boolean {
  const el = typeof document === "undefined" ? null : document.activeElement
  if (!el) return false
  const tag = el.tagName
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT"
}

export function historyAllowsStep(): boolean {
  return typeof window !== "undefined" && window.history.state?.allowStep === true
}

export function navigate(href: string, options?: { allowStep?: boolean }) {
  if (typeof window === "undefined") return
  const url = new URL(href, window.location.href)
  const next = `${url.pathname}${url.search}`
  const current = `${window.location.pathname}${window.location.search}`
  if (next !== current) window.history.pushState({ route: next, allowStep: options?.allowStep === true }, "", next)
  emitRoute()
  if (!inputFocused()) window.scrollTo(0, 0)
}

/** Drop a review URL that has nothing prepared, without adding another history entry. */
let replaceEmitQueued = false
export function replaceRoute(href: string) {
  if (typeof window === "undefined") return
  const url = new URL(href, window.location.href)
  const next = `${url.pathname}${url.search}`
  const current = `${window.location.pathname}${window.location.search}`
  if (next === current) return
  window.history.replaceState({ route: next, allowStep: false }, "", next)
  // Called from an effect after a render that already shows step 1. Emit on a
  // microtask so this does not flushSync inside that lifecycle.
  if (replaceEmitQueued) return
  replaceEmitQueued = true
  queueMicrotask(() => {
    replaceEmitQueued = false
    emitRoute()
  })
}

/** Review with nothing prepared, or a step link the user did not open from Next, shows step 1. */
export function shownStep(routeStep: number, reviewStep: number, allowed: boolean, reviewReady: boolean): number {
  if (routeStep === reviewStep && !reviewReady) return 1
  if (routeStep > 1 && !allowed) return 1
  return routeStep
}

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => emitRoute())
}

let snapshotHref = ""
let snapshotRoute: WalletRoute = HOME

function routeSnapshot(): WalletRoute {
  const href = window.location.href
  if (href !== snapshotHref) {
    snapshotHref = href
    snapshotRoute = readWalletRoute(href)
  }
  return snapshotRoute
}

export function useWalletRoute(): WalletRoute {
  return useSyncExternalStore(subscribeRoute, routeSnapshot, () => HOME)
}

export const TASKS: { flow: FlowId; title: string; text: string }[] = [
  { flow: "fund", title: "Fund an escrow", text: "Send test ETH into a new escrow for a payee." },
  { flow: "release", title: "Release a payment", text: "Pay the payee from an escrow that can be released." },
  { flow: "refund", title: "Refund a payment", text: "Send the escrowed test ETH back to the payer." },
  { flow: "dispute", title: "Open a dispute", text: "Ask the panel to decide who should get the test ETH." },
  { flow: "vote", title: "Vote (arbitrators)", text: "Cast an arbitrator vote on a dispute." },
  { flow: "withdraw", title: "Withdraw", text: "Move credited test ETH to this connected wallet." },
]
