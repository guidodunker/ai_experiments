import { readFileSync } from 'node:fs'
import type { z } from 'zod'
import { formatPost } from './parser.ts'
import { TOOLS } from './tools/index.ts'
import type { AgentTool, ToolContext } from './tools/types.ts'
import type { ChatEvent, ChatReply, SourceName, State } from './types.ts'

/** Begrenzt den Tool-Loop, damit ein verwirrtes Modell keinen endlosen Lauf abrechnet. */
export const MAX_STEPS = 4

const PROMPT = readFileSync(new URL('./prompt.md', import.meta.url), 'utf8')

/** Ein Tool mit bereits gebundenem Kontext, so wie das Modell es aufruft. */
export type BoundTool = {
  name: string
  description: string
  inputSchema: z.ZodObject
  execute: (input: unknown) => Promise<unknown>
}

/**
 * Führt den Tool-Loop mit dem LLM aus und liefert den Schlusssatz des Modells
 * (was es getan hat und warum). In Tests ein Fake, sonst `openRouterModel`.
 */
export type RunModel = (request: {
  instructions: string
  input: string
  tools: BoundTool[]
}) => Promise<string | void>

export type AgentDeps = {
  state: State
  ticketDir: string
  persist: () => Promise<void>
  runModel: RunModel
  log: (message: string) => void
  now: () => Date
  source: SourceName
  /** Antwortweg der Quelle. Fehler fängt `handleEvent` ab. */
  reply: ChatReply
  tools?: AgentTool[]
}

export function describeEvent(event: ChatEvent, ticket: number | null): string {
  const { thread } = event
  const affected = event.kind === 'NewReply' ? event.reply : thread.top
  return [
    `Ereignis: ${event.kind}`,
    `Thread-Index: ${thread.index}`,
    `Ticket: ${ticket ?? 'kein Ticket'}`,
    '',
    `Betroffener Post (Ebene ${affected.level}):`,
    formatPost(affected),
    '',
    'Kompletter Thread:',
    [thread.top, ...thread.replies].map(formatPost).join('\n'),
  ].join('\n')
}

export async function handleEvent(event: ChatEvent, deps: AgentDeps): Promise<void> {
  const ctx: ToolContext = {
    event,
    state: deps.state,
    ticketDir: deps.ticketDir,
    persist: deps.persist,
    now: deps.now,
    source: deps.source,
    // Nicht wiederholen: Das Ticket ist schon geschrieben, ein zweiter Versuch im nächsten Lauf gäbe ein Duplikat.
    reply: async (text) => {
      try {
        await deps.reply(event.thread.id, text)
      } catch (error) {
        deps.log(
          `Warnung: Antwort an Thread ${event.thread.index} gescheitert: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    },
  }

  let calls = 0
  const tools: BoundTool[] = (deps.tools ?? TOOLS).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    execute: async (input: unknown) => {
      calls++
      return tool.execute(input as never, ctx)
    },
  }))

  const ticket = deps.state.threads[event.thread.id]?.ticket ?? null
  const answer = await deps.runModel({ instructions: PROMPT, input: describeEvent(event, ticket), tools })
  if (typeof answer === 'string' && answer.trim() !== '') {
    deps.log(`Thread ${event.thread.index} → ${answer.trim().replace(/\s*\n\s*/g, ' ')}`)
  }

  if (calls >= MAX_STEPS) {
    deps.log(`Warnung: Schrittlimit (${MAX_STEPS}) bei Thread ${event.thread.index} ausgeschöpft.`)
  }
}
