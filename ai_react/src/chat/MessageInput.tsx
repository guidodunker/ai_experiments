import { useState } from 'react'

export function MessageInput({
  onSend,
  disabled,
}: {
  onSend: (text: string) => void
  disabled: boolean
}) {
  const [text, setText] = useState('')

  const submit = () => {
    const trimmed = text.trim()
    if (trimmed.length === 0 || disabled) return
    setText('')
    onSend(trimmed)
  }

  return (
    <div className="message-input">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }}
        placeholder="Ask the agent to modify this app… (Enter to send, Shift+Enter for newline)"
        rows={3}
        disabled={disabled}
      />
      <button onClick={submit} disabled={disabled || text.trim().length === 0}>
        Send
      </button>
    </div>
  )
}
