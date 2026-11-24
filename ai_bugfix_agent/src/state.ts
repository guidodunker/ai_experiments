import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import type { ChatEvent, State, Thread, ThreadState } from './types.ts'

export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'ENOENT'
  )
}

export async function loadState(path: string): Promise<State> {
  let raw: { threads: unknown }
  try {
    raw = JSON.parse(await readFile(path, 'utf8')) as { threads: unknown }
  } catch (error) {
    if (isNotFound(error)) return { threads: {} }
    throw error
  }
  return { threads: migrateThreads(raw.threads) }
}

/** Bis Stufe 2 war `threads` ein Array mit der Position als Schlüssel und `null` in Lücken. */
function migrateThreads(threads: unknown): Record<string, ThreadState> {
  if (!Array.isArray(threads)) return threads as Record<string, ThreadState>
  const result: Record<string, ThreadState> = {}
  threads.forEach((entry: ThreadState | null, index) => {
    if (entry !== null) result[String(index)] = entry
  })
  return result
}

export async function saveState(path: string, state: State): Promise<void> {
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`)
}

/** Liefert den Zustand eines Threads und legt ihn beim ersten Mal an. */
export function ensureThread(state: State, thread: Thread): ThreadState {
  const existing = state.threads[thread.id]
  if (existing !== undefined) return existing
  const created: ThreadState = { topHash: hashText(thread.top.text), replyCount: 0, ticket: null }
  state.threads[thread.id] = created
  return created
}

/** Vermerkt ein verarbeitetes Ereignis im Zustand. */
export function applyEvent(state: State, event: ChatEvent): void {
  const entry = ensureThread(state, event.thread)
  if (event.kind === 'NewThread') {
    // Bei einer Neubewertung gilt ab jetzt der neue Text; die Antworten folgen als eigene Ereignisse.
    entry.topHash = hashText(event.thread.top.text)
    entry.replyCount = 0
  } else {
    entry.replyCount = Math.max(entry.replyCount, event.replyIndex + 1)
  }
}
