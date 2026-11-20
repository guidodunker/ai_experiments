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
  try {
    return JSON.parse(await readFile(path, 'utf8')) as State
  } catch (error) {
    if (isNotFound(error)) return { threads: [] }
    throw error
  }
}

export async function saveState(path: string, state: State): Promise<void> {
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`)
}

/** Liefert den Zustand eines Threads und legt ihn beim ersten Mal an. */
export function ensureThread(state: State, thread: Thread): ThreadState {
  const existing = state.threads[thread.index]
  if (existing !== undefined && existing !== null) return existing
  const created: ThreadState = { topHash: hashText(thread.top.text), replyCount: 0, ticket: null }
  state.threads[thread.index] = created
  return created
}

/** Vermerkt ein verarbeitetes Ereignis im Zustand. */
export function applyEvent(state: State, event: ChatEvent): void {
  const entry = ensureThread(state, event.thread)
  if (event.kind === 'NewReply') {
    entry.replyCount = Math.max(entry.replyCount, event.replyIndex + 1)
  }
}
