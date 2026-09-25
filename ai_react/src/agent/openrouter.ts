import type { ChatMessage, ToolCall } from './types.ts'

export interface Usage {
  /** Cost in USD as reported by OpenRouter. */
  cost: number
  totalTokens: number
}

export interface StreamResult {
  content: string
  toolCalls: ToolCall[]
  usage: Usage
}

interface StreamChatParams {
  model: string
  messages: ChatMessage[]
  tools: unknown[]
  signal?: AbortSignal
  onDelta: (text: string) => void
}

interface DeltaToolCall {
  index: number
  id?: string
  function?: { name?: string; arguments?: string }
}

/**
 * Send one chat-completions request through the dev-server proxy and stream
 * the response. Resolves with the accumulated assistant text and tool calls.
 */
export async function streamChat(params: StreamChatParams): Promise<StreamResult> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: params.signal,
    body: JSON.stringify({
      model: params.model,
      messages: params.messages,
      tools: params.tools,
      stream: true,
      // Ask OpenRouter to include token + cost accounting in the final chunk.
      usage: { include: true },
    }),
  })

  const contentType = res.headers.get('content-type') ?? ''
  if (!res.ok || !contentType.includes('text/event-stream')) {
    const body = await res.text()
    let message = body
    try {
      const parsed = JSON.parse(body)
      message = parsed.error?.message ?? parsed.error ?? body
    } catch {
      /* keep raw body */
    }
    throw new Error(`Chat request failed (HTTP ${res.status}): ${message}`)
  }
  if (!res.body) throw new Error('Chat response had no body')

  let content = ''
  const toolCalls: ToolCall[] = []
  const usage: Usage = { cost: 0, totalTokens: 0 }
  const decoder = new TextDecoder()
  const reader = res.body.getReader()
  let buffer = ''

  const processLine = (line: string) => {
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (data === '' || data === '[DONE]') return
    let parsed: {
      error?: { message?: string }
      choices?: { delta?: { content?: string | null; tool_calls?: DeltaToolCall[] } }[]
      usage?: { cost?: number; total_tokens?: number }
    }
    try {
      parsed = JSON.parse(data)
    } catch {
      return
    }
    if (parsed.error) throw new Error(parsed.error.message ?? 'Upstream error')
    if (parsed.usage) {
      if (typeof parsed.usage.cost === 'number') usage.cost += parsed.usage.cost
      if (typeof parsed.usage.total_tokens === 'number') usage.totalTokens += parsed.usage.total_tokens
    }
    const delta = parsed.choices?.[0]?.delta
    if (!delta) return
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      content += delta.content
      params.onDelta(delta.content)
    }
    for (const tc of delta.tool_calls ?? []) {
      const existing = toolCalls[tc.index]
      if (!existing) {
        toolCalls[tc.index] = {
          id: tc.id ?? `call_${tc.index}`,
          type: 'function',
          function: {
            name: tc.function?.name ?? '',
            arguments: tc.function?.arguments ?? '',
          },
        }
      } else {
        if (tc.id) existing.id = tc.id
        if (tc.function?.name) existing.function.name += tc.function.name
        if (tc.function?.arguments) existing.function.arguments += tc.function.arguments
      }
    }
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) processLine(line.trimEnd())
  }
  if (buffer.length > 0) processLine(buffer.trimEnd())

  return { content, toolCalls: toolCalls.filter(Boolean), usage }
}
