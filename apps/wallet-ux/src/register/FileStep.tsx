import { CHECK_REGISTRATION, FILE_HELPER, FILE_TITLE, TAB_PASTE, TAB_UPLOAD } from "../registerCopy"
import type { FileTab } from "./types"

export function FileStep({
  tab,
  pasteText,
  fileName,
  onSelectTab,
  onPaste,
  onFile,
  onCheck,
}: {
  tab: FileTab
  pasteText: string
  fileName: string | null
  onSelectTab: (tab: FileTab) => void
  onPaste: (text: string) => void
  onFile: (file: File) => void
  onCheck: () => void
}) {
  return (
    <div data-testid="step-file">
      <h3>{FILE_TITLE}</h3>
      <div className="register-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "upload"}
          className={tab === "upload" ? undefined : "secondary"}
          onClick={() => onSelectTab("upload")}
        >
          {TAB_UPLOAD}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "paste"}
          className={tab === "paste" ? undefined : "secondary"}
          onClick={() => onSelectTab("paste")}
        >
          {TAB_PASTE}
        </button>
      </div>
      {tab === "upload" ? (
        <label>
          {TAB_UPLOAD}
          <input
            type="file"
            accept=".json"
            data-testid="register-file"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) onFile(file)
            }}
          />
        </label>
      ) : (
        <label>
          {TAB_PASTE}
          <textarea
            value={pasteText}
            aria-label={TAB_PASTE}
            spellCheck={false}
            rows={8}
            data-testid="register-paste"
            onChange={(event) => onPaste(event.target.value)}
          />
        </label>
      )}
      {fileName ? <p className="muted">{fileName}</p> : null}
      <p className="muted">{FILE_HELPER}</p>
      <div className="step-actions">
        <div className="step-primary">
          <button type="button" onClick={onCheck}>
            {CHECK_REGISTRATION}
          </button>
        </div>
      </div>
    </div>
  )
}
