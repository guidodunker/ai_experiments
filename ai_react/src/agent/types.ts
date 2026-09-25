// OpenAI-compatible wire format used by OpenRouter's /chat/completions.

export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

// UI transcript model — what the chat renders.

export type TranscriptItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; streaming?: boolean }
  | {
      kind: 'tool'
      id: string
      name: string
      args: string
      result?: string
      isError?: boolean
    }
  | { kind: 'error'; id: string; text: string }
  | {
      kind: 'health'
      id: string
      status: 'checking' | 'ok' | 'repairing' | 'rolled-back' | 'gave-up'
      text: string
    }
  | { kind: 'broken'; id: string; text: string; prompt: string }
  | { kind: 'cost'; id: string; usd: number; tokens: number }
