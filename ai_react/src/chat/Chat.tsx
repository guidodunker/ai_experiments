import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { CommitList } from './CommitList.tsx'
import { formatUsd } from './format.ts'
import { MessageInput } from './MessageInput.tsx'
import { MessageList } from './MessageList.tsx'
import { ModelPicker } from './ModelPicker.tsx'
import { ServicesPanel } from './ServicesPanel.tsx'
import { getSnapshot, newChat, sendMessage, subscribe } from './store.ts'
import './chat.css'

// const DEFAULT_MODEL = '~anthropic/claude-haiku-latest', 'openai/gpt-oss-20b', 'openai/gpt-5.6-luna'
const DEFAULT_MODEL = 'openai/gpt-5.6-luna' // 'openrouter/free'
const STORE_MODEL = 'agent.model'

export function Chat() {
  // All chat state lives in the module-level store (see store.ts) so an
  // agent-triggered remount of this component never interrupts a running turn.
  const { transcript, busy, sessionCost, sessionTokens } = useSyncExternalStore(
    subscribe,
    getSnapshot,
  )
  const [model, setModel] = useState(() => localStorage.getItem(STORE_MODEL) ?? DEFAULT_MODEL)

  useEffect(() => localStorage.setItem(STORE_MODEL, model), [model])

  const send = useCallback((text: string) => void sendMessage(text, model), [model])

  return (
    <div className="chat-layout">
      <div className="chat">
        <header className="chat-header">
          <span className="chat-title">⚡ Coding Agent</span>
          <ModelPicker model={model} onChange={setModel} disabled={busy} />
          <span
            className="session-cost"
            title={`${sessionTokens.toLocaleString()} tokens this session`}
          >
            Σ {sessionCost > 0 ? formatUsd(sessionCost) : '$0'}
          </span>
          <button className="chat-new" onClick={newChat} disabled={busy}>
            New chat
          </button>
        </header>
        <MessageList items={transcript} busy={busy} />
        <ServicesPanel />
        <MessageInput onSend={send} disabled={busy} />
      </div>
      <CommitList />
    </div>
  )
}
