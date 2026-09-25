// Pure helpers behind the health check: what counts as "broken", whether a
// repair loop is making progress, and the text the model gets to read. No
// browser and no server APIs in here — that is what makes it unit-testable.

export type ProblemKind = 'probe' | 'runtime' | 'hmr' | 'type' | 'service' | 'infra'

export interface Problem {
  kind: ProblemKind
  message: string
  file?: string
  line?: number
  col?: number
  code?: string
}

/**
 * Probe, runtime, HMR and service failures mean the running app is broken and
 * may trigger a rollback. Type errors only break `npm run build`, never the app
 * in the browser; infra failures (Docker unreachable, image pull) are
 * environment problems rather than bad code. Neither may discard the agent's
 * work.
 */
export function isAppBroken(problems: Problem[]): boolean {
  return problems.some((p) => p.kind !== 'type' && p.kind !== 'infra')
}

/**
 * Stable fingerprint of a set of problems. Two identical signatures in a row
 * mean the repair loop is stuck and further attempts would just cost tokens.
 */
export function signatureOf(problems: Problem[]): string {
  return problems
    .map((p) => `${p.kind}:${p.file ?? '-'}:${p.line ?? '-'}:${p.code ?? p.message}`)
    .sort()
    .join('|')
}

const LABEL: Record<ProblemKind, string> = {
  probe: 'MODULE FAILED TO LOAD',
  runtime: 'RUNTIME ERROR',
  hmr: 'VITE ERROR',
  type: 'TYPE ERROR',
  service: 'SERVICE FAILED',
  infra: 'INFRASTRUCTURE PROBLEM',
}

function location(p: Problem): string {
  if (!p.file) return ''
  if (p.line === undefined) return ` ${p.file}`
  return ` ${p.file}(${p.line}${p.col === undefined ? '' : `,${p.col}`})`
}

export function buildReport(problems: Problem[], attempt: number, maxAttempts: number): string {
  const lines = problems.map(
    (p) => `- [${LABEL[p.kind]}]${location(p)}${p.code ? ` ${p.code}` : ''}: ${p.message}`,
  )
  return [
    `AUTOMATIC HEALTH CHECK FAILED (repair attempt ${attempt} of ${maxAttempts}).`,
    'This is not a user message — the dev server checked the app after your changes.',
    '',
    ...lines,
    '',
    isAppBroken(problems)
      ? 'The running app is broken. Read the files you just changed, find the cause, and fix it with write_file. If you cannot fix it, say so plainly instead of guessing — your changes are then rolled back automatically.'
      : 'The app still runs, but the build is broken. Fix the reported type errors with write_file.',
  ].join('\n')
}
