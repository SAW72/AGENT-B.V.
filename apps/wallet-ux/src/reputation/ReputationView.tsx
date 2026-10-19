import { useEffect, useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { BASE_SEPOLIA_CHAIN_ID } from "../addresses"
import { DISPLAY_NAME } from "../brand"
import {
  fetchReputationBalance,
  fetchReputationConfig,
  fetchReputationHistory,
  reputationRoot,
  ReputationRequestError,
} from "./api"
import {
  BALANCE_LINE,
  LEDGERS_ARE_SEPARATE,
  NETWORK_ERROR,
  PLACEHOLDER_ABUSE,
  PLACEHOLDER_CAPS,
  PLACEHOLDER_DISCLAIMER,
  PLACEHOLDER_ELIGIBILITY,
  UNAVAILABLE,
  WITHHELD,
  capLabel,
  outcomePlain,
  pointsAreWithheld,
  reputationHeading,
  txExplorerUrl,
} from "./copy"
import type {
  DisclaimerLinks,
  HistoryItem,
  LedgerPoints,
  ReputationConfig,
  ReputationHistory,
  ReputationLedgerName,
  ReputationSnapshot,
} from "./types"

const INTRODUCED_KEY = "agent-bv-reputation-introduced"

/** First read in this page load. Writing the flag must not flip the label mid-session. */
let sessionIntroduced: boolean | null = null

export function resetReputationIntroduction(): void {
  sessionIntroduced = null
  try {
    window.localStorage.removeItem(INTRODUCED_KEY)
  } catch {
    /* ignore */
  }
}

/** Drop the in-memory page-load cache without clearing storage. */
export function forgetReputationSession(): void {
  sessionIntroduced = null
}

export type WalletChain = number | null | "conflict"

export type ReputationViewProps = {
  connected: boolean
  chainId: WalletChain
  address: string | null
  relayerUrl: string | null
  /** When set, skips localStorage and forces the first-use or later label. */
  introduced?: boolean
  /** EXAMPLE DATA snapshot. Skips the network. */
  example?: ReputationSnapshot | null
  exampleLabel?: string | null
  fetchImpl?: typeof fetch
}

function readIntroduced(): boolean {
  if (sessionIntroduced !== null) return sessionIntroduced
  try {
    sessionIntroduced = window.localStorage.getItem(INTRODUCED_KEY) === "1"
  } catch {
    sessionIntroduced = false
  }
  return sessionIntroduced
}

function markIntroduced(): void {
  try {
    window.localStorage.setItem(INTRODUCED_KEY, "1")
  } catch {
    /* Private mode and quota failures leave the long label in place. */
  }
}

function safeHref(value: string | null): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" && url.protocol !== "http:") return null
    return url.toString()
  } catch {
    return null
  }
}

function statusClass(status: string): string {
  if (status === "final") return "pill ok"
  if (status === "cancelled") return "pill bad"
  if (status === "provisional") return "pill info"
  return "pill"
}

function formatSlot(value: number | string | null): string {
  if (value === null) return "Not set"
  return String(value)
}

function BalanceNotice({ apiText }: { apiText: string }) {
  const extra = apiText.trim()
  return (
    <>
      <p className="muted" data-testid="balance-line">{BALANCE_LINE}</p>
      {extra.length > 0 && extra !== BALANCE_LINE ? <p className="muted">{extra}</p> : null}
    </>
  )
}

function LedgerBalance({
  ledger,
  points,
  withheld,
  apiText,
}: {
  ledger: ReputationLedgerName
  points: LedgerPoints
  withheld: boolean
  apiText: string
}) {
  return (
    <div data-testid={`${ledger}-balance`}>
      {withheld ? (
        <div className="callout" data-testid={`${ledger}-withheld`} role="status">
          <strong>{WITHHELD}</strong>
        </div>
      ) : (
        <dl className="result" data-testid={`${ledger}-points`}>
          <div>
            <dt>Final</dt>
            <dd>{points.final}</dd>
          </div>
          <div>
            <dt>Provisional</dt>
            <dd>{points.provisional}</dd>
          </div>
        </dl>
      )}
      <BalanceNotice apiText={apiText} />
    </div>
  )
}

function HistoryRow({ item }: { item: HistoryItem }) {
  const href = /^0x[0-9a-fA-F]{64}$/.test(item.tx_hash) ? txExplorerUrl(item.tx_hash) : null
  return (
    <li className="history-row" data-testid="history-row">
      <div>
        <div data-testid="history-outcome">{outcomePlain(item.outcome_code)}</div>
        <div className="muted">Block {item.block_number}</div>
      </div>
      <div data-testid="history-points">{item.points} points</div>
      <span className={statusClass(item.status)} data-testid="history-status">
        {item.status}
      </span>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" data-testid="history-tx">
          View transaction
        </a>
      ) : (
        <span className="muted">No transaction link</span>
      )}
    </li>
  )
}

function HistoryList({
  page,
  onLoadMore,
}: {
  page: ReputationHistory
  onLoadMore: ((cursor: string) => Promise<ReputationHistory>) | null
}) {
  const [items, setItems] = useState(page.items)
  const [cursor, setCursor] = useState(page.next_cursor)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pageKey = `${page.address}:${page.ledger}:${page.items.map((item) => item.entry_id).join("|")}:${page.next_cursor ?? ""}`

  useEffect(() => {
    setItems(page.items)
    setCursor(page.next_cursor)
    setError(null)
    setPending(false)
  }, [pageKey, page.items, page.next_cursor])

  async function loadMore() {
    if (!cursor || !onLoadMore || pending) return
    setPending(true)
    setError(null)
    try {
      const next = await onLoadMore(cursor)
      setItems((current) => [...current, ...next.items])
      setCursor(next.next_cursor)
    } catch (err) {
      setError(err instanceof ReputationRequestError ? err.message : NETWORK_ERROR)
    } finally {
      setPending(false)
    }
  }

  return (
    <div data-testid={`${page.ledger}-history`}>
      {items.length === 0 ? <p className="muted">No history rows.</p> : null}
      {items.length > 0 ? (
        <ul className="history">
          {items.map((item) => (
            <HistoryRow key={item.entry_id} item={item} />
          ))}
        </ul>
      ) : null}
      {error ? (
        <p className="bad" role="alert">
          {error}
        </p>
      ) : null}
      {cursor ? (
        <button type="button" data-testid={`load-more-${page.ledger}`} onClick={() => void loadMore()} disabled={pending || !onLoadMore}>
          {pending ? "Loading…" : "Load more"}
        </button>
      ) : null}
    </div>
  )
}

function DraftMark({ status }: { status: string }) {
  return <span className="pill draft">{status}</span>
}

function OpenItems({ links, capsAreDraft }: { links: DisclaimerLinks | null; capsAreDraft: boolean }) {
  const eligibility = safeHref(links?.eligibility_notice ?? null)
  const abuse = safeHref(links?.abuse_policy ?? null)
  const disclaimerSlots: { key: keyof DisclaimerLinks; label: string }[] = [
    { key: "master_disclaimer", label: "Master disclaimer" },
    { key: "legal_notice_url", label: "Legal notice" },
    { key: "as_is", label: "AS IS" },
    { key: "not_investment", label: "Not an investment" },
  ]
  const publishedDisclaimer = links
    ? disclaimerSlots.flatMap((slot) => {
        const href = safeHref(links[slot.key])
        return href ? [{ ...slot, href }] : []
      })
    : []

  return (
    <section aria-labelledby="open-items-heading" data-testid="open-items">
      <h3 id="open-items-heading">Open items</h3>
      {eligibility ? (
        <p>
          <a href={eligibility} target="_blank" rel="noreferrer">
            Eligibility notice
          </a>
        </p>
      ) : (
        <p data-testid="placeholder-7">{PLACEHOLDER_ELIGIBILITY}</p>
      )}
      {abuse ? (
        <p>
          <a href={abuse} target="_blank" rel="noreferrer">
            Abuse policy
          </a>
        </p>
      ) : (
        <p data-testid="placeholder-9">{PLACEHOLDER_ABUSE}</p>
      )}
      {links === null || publishedDisclaimer.length === 0 ? (
        <p data-testid="placeholder-11">{PLACEHOLDER_DISCLAIMER}</p>
      ) : (
        <ul className="plain" data-testid="disclaimer-links">
          {publishedDisclaimer.map((slot) => (
            <li key={slot.key}>
              <a href={slot.href} target="_blank" rel="noreferrer">
                {slot.label}
              </a>
            </li>
          ))}
        </ul>
      )}
      {links !== null && publishedDisclaimer.length > 0 && publishedDisclaimer.length < disclaimerSlots.length ? (
        <p data-testid="placeholder-11">{PLACEHOLDER_DISCLAIMER}</p>
      ) : null}
      {capsAreDraft ? <p data-testid="placeholder-12">{PLACEHOLDER_CAPS}</p> : null}
    </section>
  )
}

function CapsList({ config }: { config: ReputationConfig }) {
  const caps = Object.entries(config.caps)
  return (
    <section className="card" aria-labelledby="caps-heading" data-testid="draft-caps">
      <h2 id="caps-heading">Caps</h2>
      <ul className="plain">
        {caps.map(([key, slot]) => (
          <li key={key} data-testid={`cap-${key}`}>
            {capLabel(key)}: {slot.value} <DraftMark status={slot.status} />
          </li>
        ))}
      </ul>
      <h3>Season and day</h3>
      <ul className="plain">
        <li>
          Season length: {formatSlot(config.thresholds.season_length_days.value)} days{" "}
          <DraftMark status={config.thresholds.season_length_days.status} />
        </li>
        <li>
          Season start block: {formatSlot(config.thresholds.season_start_block.value)}{" "}
          <DraftMark status={config.thresholds.season_start_block.status} />
        </li>
        <li>
          Season start time: {formatSlot(config.thresholds.season_start_timestamp.value)}{" "}
          <DraftMark status={config.thresholds.season_start_timestamp.status} />
        </li>
        <li>
          Day boundary: {config.thresholds.day_boundary.value} <DraftMark status={config.thresholds.day_boundary.status} />
        </li>
      </ul>
    </section>
  )
}

function LedgerPanel({
  ledger,
  title,
  points,
  withheld,
  apiText,
  history,
  onLoadMore,
}: {
  ledger: ReputationLedgerName
  title: string
  points: LedgerPoints
  withheld: boolean
  apiText: string
  history: ReputationHistory
  onLoadMore: ((cursor: string) => Promise<ReputationHistory>) | null
}) {
  return (
    <section className="card" aria-labelledby={`${ledger}-heading`} data-testid={`${ledger}-panel`}>
      <h2 id={`${ledger}-heading`}>{title}</h2>
      <p className="muted mono">{points.ledger}</p>
      <LedgerBalance ledger={ledger} points={points} withheld={withheld} apiText={apiText} />
      <h3>History</h3>
      <HistoryList page={history} onLoadMore={onLoadMore} />
    </section>
  )
}

export function ReputationView(props: ReputationViewProps) {
  const visible = props.connected && props.chainId === BASE_SEPOLIA_CHAIN_ID
  const fetchImpl = props.fetchImpl ?? fetch
  const example = props.example ?? null
  const introducedProp = props.introduced
  const [introduced] = useState(() => (introducedProp !== undefined ? introducedProp : readIntroduced()))

  useEffect(() => {
    if (!visible || introducedProp !== undefined) return
    markIntroduced()
  }, [visible, introducedProp])

  const root = useMemo(() => {
    if (!props.relayerUrl) return null
    try {
      return reputationRoot(props.relayerUrl)
    } catch {
      return null
    }
  }, [props.relayerUrl])

  const urlInvalid = props.relayerUrl != null && root == null
  const canFetch = visible && example == null && root != null && props.address != null
  const address = props.address
  const queryRoot = root

  const balanceQuery = useQuery({
    queryKey: ["reputation-balance", queryRoot, address],
    queryFn: () => fetchReputationBalance(queryRoot as string, address as string, fetchImpl),
    enabled: canFetch,
    retry: false,
  })
  const configQuery = useQuery({
    queryKey: ["reputation-config", queryRoot],
    queryFn: () => fetchReputationConfig(queryRoot as string, fetchImpl),
    enabled: canFetch,
    retry: false,
  })
  const usageQuery = useQuery({
    queryKey: ["reputation-history", queryRoot, address, "usage"],
    queryFn: () => fetchReputationHistory(queryRoot as string, address as string, "usage", null, fetchImpl),
    enabled: canFetch,
    retry: false,
  })
  const arbitratorQuery = useQuery({
    queryKey: ["reputation-history", queryRoot, address, "arbitrator"],
    queryFn: () => fetchReputationHistory(queryRoot as string, address as string, "arbitrator", null, fetchImpl),
    enabled: canFetch,
    retry: false,
  })

  if (!visible) return null

  const live =
    balanceQuery.data && configQuery.data && usageQuery.data && arbitratorQuery.data
      ? {
          balance: balanceQuery.data,
          config: configQuery.data,
          history: { usage: usageQuery.data, arbitrator: arbitratorQuery.data },
        }
      : null
  const snapshot = example ?? live
  const productTitle = snapshot?.config.product_title ?? DISPLAY_NAME
  const heading = reputationHeading(productTitle, introduced)
  const queryError = balanceQuery.error ?? configQuery.error ?? usageQuery.error ?? arbitratorQuery.error
  const errorMessage = urlInvalid
    ? NETWORK_ERROR
    : queryError instanceof ReputationRequestError
      ? queryError.message
      : queryError
        ? NETWORK_ERROR
        : null
  const loading = canFetch && !snapshot && !queryError
  const withheld = snapshot
    ? pointsAreWithheld(snapshot.balance.eligibility.status, snapshot.balance.eligibility.points_withheld)
    : false
  const capsAreDraft =
    !snapshot || snapshot.config.status === "draft" || Object.values(snapshot.config.caps).some((slot) => slot.status === "draft")

  function loadMore(ledger: ReputationLedgerName): ((cursor: string) => Promise<ReputationHistory>) | null {
    if (example || !queryRoot || !address) return null
    return (cursor) => fetchReputationHistory(queryRoot, address, ledger, cursor, fetchImpl)
  }

  return (
    <div data-testid="reputation-view" data-example={example ? "true" : "false"}>
      <section className="card" aria-labelledby="reputation-heading">
        <div className="rep-head">
          <h2 id="reputation-heading" data-testid="reputation-label">{heading}</h2>
          <span className="pill info chain-badge" data-testid="chain-badge">{BASE_SEPOLIA_CHAIN_ID}</span>
        </div>
        {example ? (
          <div className="callout" data-testid="example-data-banner" role="status">
            <strong>EXAMPLE DATA</strong>
            <p>{props.exampleLabel ?? "Not a live Base Sepolia scan. Fixture logs only."}</p>
          </div>
        ) : null}
        <p className="muted">{LEDGERS_ARE_SEPARATE}</p>
        {props.relayerUrl == null && !example ? (
          <p className="muted" data-testid="reputation-unavailable">{UNAVAILABLE}</p>
        ) : null}
        {errorMessage ? (
          <p className="banner" role="alert" data-testid="reputation-error">{errorMessage}</p>
        ) : null}
        {loading ? <p className="banner info">Loading testnet reputation.</p> : null}
        {snapshot ? (
          <OpenItems links={snapshot.balance.disclaimer.links} capsAreDraft={capsAreDraft} />
        ) : null}
      </section>

      {snapshot ? (
        <>
          <LedgerPanel
            ledger="usage"
            title="Usage ledger"
            points={snapshot.balance.ledgers.usage}
            withheld={withheld}
            apiText={snapshot.balance.disclaimer.text}
            history={snapshot.history.usage}
            onLoadMore={loadMore("usage")}
          />
          <LedgerPanel
            ledger="arbitrator"
            title="Arbitrator ledger"
            points={snapshot.balance.ledgers.arbitrator}
            withheld={withheld}
            apiText={snapshot.balance.disclaimer.text}
            history={snapshot.history.arbitrator}
            onLoadMore={loadMore("arbitrator")}
          />
          <CapsList config={snapshot.config} />
        </>
      ) : null}
    </div>
  )
}
