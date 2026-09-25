import { buildReport, isAppBroken, signatureOf } from './healthReport.ts'
import { streamChat } from './openrouter.ts'
import { executeTool, toolSchemas } from './tools.ts'
import type { ChatMessage } from './types.ts'
import { rollbackTurn, verifyApp } from './verify.ts'

const MAX_ITERATIONS = 20
const MAX_REPAIRS = 3

export type HealthStatus = 'checking' | 'ok' | 'repairing' | 'rolled-back' | 'gave-up'

export interface AgentCallbacks {
  /** A new assistant message started streaming; returns nothing. */
  onAssistantStart: (id: string) => void
  /** Streaming text delta for the assistant message with the given id. */
  onAssistantDelta: (id: string, delta: string) => void
  /** The assistant message finished (text is final). */
  onAssistantDone: (id: string) => void
  /** The model requested a tool call (before execution). */
  onToolCall: (id: string, name: string, args: string) => void
  /** A tool call finished executing. */
  onToolResult: (id: string, result: string, isError: boolean) => void
  /** The health check changed state; `id` is stable per check. */
  onHealth: (id: string, status: HealthStatus, text: string) => void
  /** The whole turn finished; totals summed across every model call. */
  onTurnUsage: (usd: number, tokens: number) => void
}

let idCounter = 0
const nextId = () => `m${Date.now()}_${idCounter++}`

/** Path of a successful write_file call, for the module probe. */
function writtenPath(argsJson: string): string | null {
  try {
    const { path } = JSON.parse(argsJson) as { path?: unknown }
    return typeof path === 'string' ? path : null
  } catch {
    return null
  }
}

/**
 * Run one full agent turn: repeatedly call the model, execute any requested
 * tools, and feed results back until the model answers with plain text AND the
 * app still works. Mutates `messages` in place (the wire-format history).
 */
export async function runAgentTurn(params: {
  model: string
  messages: ChatMessage[]
  turnId: string
  callbacks: AgentCallbacks
  signal?: AbortSignal
}): Promise<void> {
  const { model, messages, turnId, callbacks, signal } = params
  let totalCost = 0
  let totalTokens = 0

  const turnStartedAt = Date.now()
  const writtenPaths: string[] = []
  // A turn that only started or changed a service writes no files, but still
  // has to pass the health gate.
  let touchedServices = false
  let repairs = 0
  let lastSignature = ''

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const assistantId = nextId()
    callbacks.onAssistantStart(assistantId)
    const { content, toolCalls, usage } = await streamChat({
      model,
      messages,
      tools: toolSchemas,
      signal,
      onDelta: (delta) => callbacks.onAssistantDelta(assistantId, delta),
    })
    callbacks.onAssistantDone(assistantId)
    totalCost += usage.cost
    totalTokens += usage.totalTokens

    messages.push({
      role: 'assistant',
      content: content.length > 0 ? content : null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    })

    if (toolCalls.length > 0) {
      for (const tc of toolCalls) {
        callbacks.onToolCall(tc.id, tc.function.name, tc.function.arguments)
        const { result, isError } = await executeTool(
          tc.function.name,
          tc.function.arguments,
          turnId,
        )
        callbacks.onToolResult(tc.id, result, isError)
        if (tc.function.name === 'write_file' && !isError) {
          const path = writtenPath(tc.function.arguments)
          if (path && !writtenPaths.includes(path)) writtenPaths.push(path)
        }
        if (tc.function.name.endsWith('_service') && !isError) touchedServices = true
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: isError ? `ERROR: ${result}` : result,
        })
      }
      continue
    }

    // Plain answer. A turn that changed nothing needs no health check.
    if (writtenPaths.length === 0 && !touchedServices) {
      callbacks.onTurnUsage(totalCost, totalTokens)
      return
    }

    const healthId = `health_${turnId}_${repairs}`
    callbacks.onHealth(healthId, 'checking', 'Checking whether the app still works…')
    const problems = await verifyApp({ turnStartedAt, writtenPaths })

    if (problems.length === 0) {
      callbacks.onHealth(healthId, 'ok', 'App loads, no type errors.')
      callbacks.onTurnUsage(totalCost, totalTokens)
      return
    }

    const signature = signatureOf(problems)
    const stalled = signature === lastSignature
    lastSignature = signature
    repairs += 1

    const broken = isAppBroken(problems)
    const summary = problems
      .slice(0, 3)
      .map((p) => `${p.file ?? 'app'}: ${p.message}`)
      .join(' · ')

    if (repairs > MAX_REPAIRS || stalled) {
      if (broken) {
        const snapshot = await rollbackTurn(turnId)
        callbacks.onHealth(
          healthId,
          'rolled-back',
          stalled
            ? `The app stayed broken in the same way twice — changes rolled back${snapshot ? ` to ${snapshot}` : ''}. ${summary}`
            : `The app is still broken after ${MAX_REPAIRS} repair attempts — changes rolled back${snapshot ? ` to ${snapshot}` : ''}. ${summary}`,
        )
      } else {
        // Build-only errors never roll back: the app runs, npm run build does not.
        callbacks.onHealth(
          healthId,
          'gave-up',
          `The app runs, but type errors remain and were not fixed: ${summary}`,
        )
      }
      callbacks.onTurnUsage(totalCost, totalTokens)
      return
    }

    callbacks.onHealth(
      healthId,
      'repairing',
      `${broken ? 'App is broken' : 'Build is broken'} — repair attempt ${repairs} of ${MAX_REPAIRS}: ${summary}`,
    )
    messages.push({ role: 'user', content: buildReport(problems, repairs, MAX_REPAIRS) })
  }

  throw new Error(`Agent stopped after ${MAX_ITERATIONS} iterations without a final answer.`)
}
