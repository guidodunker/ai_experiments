import { useEffect, useRef } from 'react'
import type { TranscriptItem } from '../agent/types.ts'
import { formatUsd } from './format.ts'
import { repairNow } from './store.ts'
import { ToolCallCard } from './ToolCallCard.tsx'

export function MessageList({ items, busy }: { items: TranscriptItem[]; busy: boolean }) {
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [items, busy])

  return (
    <div className="message-list">
      {items.length === 0 && (
        <div className="empty-hint">
          <p>
            This chat drives a coding agent that can modify <strong>this very app</strong>. Try:
          </p>
          <p className="empty-example">
            “Create a src/components/HelloWorld.tsx component and render it above the chat.”
          </p>
        </div>
      )}
      {items.map((item) => {
        switch (item.kind) {
          case 'user':
            return (
              <div key={item.id} className="msg msg-user">
                {item.text}
              </div>
            )
          case 'assistant':
            if (item.text.length === 0 && !item.streaming) return null
            return (
              <div key={item.id} className="msg msg-assistant">
                {item.text}
                {item.streaming && <span className="cursor">▋</span>}
              </div>
            )
          case 'tool':
            return <ToolCallCard key={item.id} item={item} />
          case 'error':
            return (
              <div key={item.id} className="msg msg-error">
                ⚠ {item.text}
              </div>
            )
          case 'health':
            return (
              <div key={item.id} className={`msg-health msg-health-${item.status}`}>
                {item.status === 'checking' && '🔍 '}
                {item.status === 'ok' && '✓ '}
                {item.status === 'repairing' && '🔧 '}
                {item.status === 'rolled-back' && '⏪ '}
                {item.status === 'gave-up' && '⚠ '}
                {item.text}
              </div>
            )
          case 'broken':
            return (
              <div key={item.id} className="msg msg-broken">
                <span>⚠ {item.text}</span>
                <button className="repair-button" onClick={() => repairNow(item.prompt)}>
                  Repair
                </button>
              </div>
            )
          case 'cost':
            return (
              <div key={item.id} className="msg-cost">
                {item.usd > 0 ? formatUsd(item.usd) : 'free'} · {item.tokens.toLocaleString()} tokens
              </div>
            )
        }
      })}
      {busy && <div className="busy-indicator">working…</div>}
      <div ref={endRef} />
    </div>
  )
}
