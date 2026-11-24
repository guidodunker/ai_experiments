import type { z } from 'zod'
import type { ChatEvent, SourceName, State } from '../types.ts'

/** Was ein Tool vom Agenten bekommt. Das LLM sieht davon nichts. */
export type ToolContext = {
  event: ChatEvent
  state: State
  ticketDir: string
  /** Schreibt den Zustand sofort auf die Platte. */
  persist: () => Promise<void>
  now: () => Date
  source: SourceName
  /** Antwortet im Thread des Ereignisses. Wirft nie, Fehler stehen als Warnung im Log. */
  reply: (text: string) => Promise<void>
  /** URL des Threads für den Ticketkopf. undefined, wenn die Quelle keine hat oder die Abfrage scheitert. */
  link: () => Promise<string | undefined>
}

/**
 * Ein Tool unabhängig vom LLM-SDK. `llm.ts` übersetzt es in ein
 * OpenRouter-Tool; Tests rufen `execute` direkt auf.
 */
export type AgentTool = {
  name: string
  description: string
  inputSchema: z.ZodObject
  execute: (input: never, ctx: ToolContext) => Promise<unknown>
}

export function defineTool<S extends z.ZodObject>(tool: {
  name: string
  description: string
  inputSchema: S
  execute: (input: z.infer<S>, ctx: ToolContext) => Promise<unknown>
}): AgentTool & { execute: (input: z.infer<S>, ctx: ToolContext) => Promise<unknown> } {
  return tool
}
