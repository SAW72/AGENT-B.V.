import { visibleDetail } from "./revert"

export function ErrorNotice({
  main,
  detail,
  link,
}: {
  main: string
  detail?: string | null
  link?: { href: string; label: string } | null
}) {
  const shown = visibleDetail(detail)
  return (
    <div className="error-notice" role="alert" aria-live="assertive">
      <p className="error-notice-main icon-bad">{main}</p>
      {link ? (
        <p className="error-notice-detail">
          <a href={link.href}>{link.label}</a>
        </p>
      ) : null}
      {shown ? <p className="error-notice-detail">{shown}</p> : null}
    </div>
  )
}
