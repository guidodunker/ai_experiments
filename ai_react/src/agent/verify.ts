// The turn gate: after the agent wrote files, find out whether the app still
// works before telling the user "done". Three sources, cheapest first.

import { errorsSince, waitForHmr } from './health.ts'
import type { Problem } from './healthReport.ts'
import { problemsFromServices, type ServiceStatus } from './serviceHealth.ts'

interface ProbeResponse {
  failures?: { path: string; message: string }[]
}

interface TypecheckResponse {
  diagnostics?: { file: string; line: number; col: number; code: string; message: string }[]
}

export async function verifyApp(params: {
  turnStartedAt: number
  writtenPaths: string[]
}): Promise<Problem[]> {
  await waitForHmr()

  const problems: Problem[] = []

  // 0. Cheapest of all: an in-memory read of supervisor state.
  try {
    const res = await fetch('/api/services')
    const body = (await res.json()) as { services?: ServiceStatus[] }
    problems.push(...problemsFromServices(body.services ?? []))
  } catch (err) {
    console.warn('[health] service status unreachable:', err)
  }

  // 1. Do the changed modules load at all?
  try {
    const res = await fetch('/api/health/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: params.writtenPaths }),
    })
    const body = (await res.json()) as ProbeResponse
    for (const failure of body.failures ?? []) {
      problems.push({ kind: 'probe', file: failure.path, message: failure.message })
    }
  } catch (err) {
    // An unreachable dev server is an infrastructure problem, not broken code.
    // Reporting it as breakage would roll back perfectly good changes.
    console.warn('[health] probe unreachable:', err)
  }

  // 2. Anything that blew up in the browser since this turn started.
  problems.push(...errorsSince(params.turnStartedAt))

  // 3. Type errors — slowest, and the only kind that never causes a rollback.
  try {
    const res = await fetch('/api/health/typecheck')
    const body = (await res.json()) as TypecheckResponse
    for (const d of body.diagnostics ?? []) {
      problems.push({
        kind: 'type',
        file: d.file,
        line: d.line,
        col: d.col,
        code: d.code,
        message: d.message,
      })
    }
  } catch (err) {
    console.warn('[health] typecheck unreachable:', err)
  }

  return problems
}

/** Ask the dev server to restore this turn's pre-write snapshot. */
export async function rollbackTurn(turnId: string): Promise<string | null> {
  try {
    const res = await fetch('/api/git/rollback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId }),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { snapshot?: string }
    return body.snapshot ?? null
  } catch {
    return null
  }
}
