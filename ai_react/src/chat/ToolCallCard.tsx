import { useState } from 'react'
import type { TranscriptItem } from '../agent/types.ts'

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>

function argSummary(args: string): string {
  try {
    const parsed = JSON.parse(args)
    if (typeof parsed.path === 'string') return parsed.path
  } catch {
    /* args may still be streaming/partial */
  }
  return ''
}

export function ToolCallCard({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false)
  const pending = item.result === undefined
  const status = pending ? '…' : item.isError ? '✗' : '✓'

  return (
    <div className={`tool-card ${item.isError ? 'tool-error' : ''}`}>
      <button className="tool-header" onClick={() => setOpen((o) => !o)}>
        <span className={`tool-status ${pending ? 'pending' : item.isError ? 'err' : 'ok'}`}>
          {status}
        </span>
        <code className="tool-name">{item.name}</code>
        <span className="tool-path">{argSummary(item.args)}</span>
        <span className="tool-chevron">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="tool-body">
          <div className="tool-section">
            <div className="tool-label">arguments</div>
            <pre>{item.args}</pre>
          </div>
          {item.result !== undefined && (
            <div className="tool-section">
              <div className="tool-label">result</div>
              <pre>{item.result}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
