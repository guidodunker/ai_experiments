// Collects everything in the browser that says "the app is broken": uncaught
// errors, unhandled rejections, Vite's HMR error payloads, and React render
// crashes reported by AppErrorBoundary. Lives in src/agent, which is
// write-protected — the agent cannot disable its own smoke detector.

import type { Problem } from './healthReport.ts'

const MAX_ENTRIES = 20

// Vite colours its error messages; built from the char code so the source file
// stays free of raw control characters.
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g')

interface Entry {
  at: number
  problem: Problem
}

const entries: Entry[] = []
const listeners = new Set<(problem: Problem) => void>()

function record(problem: Problem): void {
  entries.push({ at: Date.now(), problem })
  if (entries.length > MAX_ENTRIES) entries.shift()
  for (const listener of listeners) listener(problem)
}

/** Problems recorded at or after `since` (a Date.now() timestamp). */
export function errorsSince(since: number): Problem[] {
  return entries.filter((e) => e.at >= since).map((e) => e.problem)
}

/** Notified for every new problem — used by the watchdog in the chat store. */
export function subscribe(listener: (problem: Problem) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Called by AppErrorBoundary when React caught a render crash. */
export function reportRenderError(error: Error, componentStack: string): void {
  const frames = componentStack.trim().split('\n').slice(0, 3).join('\n')
  record({ kind: 'runtime', message: `${error.message}\n${frames}` })
}

window.addEventListener('error', (event) => {
  record({
    kind: 'runtime',
    message: event.message,
    file: event.filename,
    line: event.lineno,
    col: event.colno,
  })
})

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason as Error | undefined
  record({
    kind: 'runtime',
    message: `Unhandled rejection: ${reason?.message ?? String(event.reason)}`,
  })
})

interface ViteErrorPayload {
  err: { message: string; id?: string; loc?: { line: number; column: number } }
}

if (import.meta.hot) {
  // Cast inside instead of annotating the parameter: Vite declares its own
  // payload type for this event, and a narrower annotation on the handler is
  // rejected as incompatible.
  import.meta.hot.on('vite:error', (rawPayload) => {
    const { err } = rawPayload as unknown as ViteErrorPayload
    record({
      kind: 'hmr',
      message: err.message.replace(ANSI, '').replace(/\s+/g, ' ').trim(),
      file: err.id,
      line: err.loc?.line,
      col: err.loc?.column,
    })
  })
}

/**
 * Resolves once HMR has applied its pending update, or after `timeoutMs` — the
 * turn gate must not check the app while Vite is still swapping modules in.
 */
export function waitForHmr(timeoutMs = 600): Promise<void> {
  return new Promise((resolve) => {
    const hot = import.meta.hot
    if (!hot) {
      setTimeout(resolve, timeoutMs)
      return
    }
    const done = () => {
      clearTimeout(timer)
      hot.off('vite:afterUpdate', done)
      resolve()
    }
    const timer = setTimeout(() => {
      hot.off('vite:afterUpdate', done)
      resolve()
    }, timeoutMs)
    hot.on('vite:afterUpdate', done)
  })
}
