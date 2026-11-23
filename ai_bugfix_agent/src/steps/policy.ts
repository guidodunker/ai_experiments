import { isAbsolute, relative, resolve, sep } from 'node:path'

export type Mode = 'analyze' | 'plan'
export type PolicyContext = { mode: Mode; worktree: string; testCommand: string }
export type Decision = { allow: true } | { allow: false; reason: string }

const ALLOW: Decision = { allow: true }

function forbidden(tool: string): Decision {
  return { allow: false, reason: `Das Tool ${tool} ist in diesem Schritt nicht erlaubt.` }
}

/**
 * Liegt `path` (absolut oder relativ zum Worktree) im Worktree?
 * `path.relative` vergleicht unter Windows ohne Groß- und Kleinschreibung
 * und liefert für ein anderes Laufwerk einen absoluten Pfad.
 */
export function isInside(worktree: string, path: string): boolean {
  const rel = relative(worktree, resolve(worktree, path))
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

function checkPath(worktree: string, value: unknown, optional: boolean): Decision {
  if (value === undefined && optional) return ALLOW
  if (typeof value !== 'string') return { allow: false, reason: 'Pfad fehlt oder ist kein Text.' }
  return isInside(worktree, value)
    ? ALLOW
    : { allow: false, reason: `${value} liegt außerhalb des Arbeitsverzeichnisses.` }
}

/** Entscheidet über einen Tool-Aufruf einer Sitzung. Was hier nicht erlaubt wird, ist verboten. */
export function decide(tool: string, input: Record<string, unknown>, ctx: PolicyContext): Decision {
  switch (tool) {
    case 'Read':
      return checkPath(ctx.worktree, input.file_path, false)
    case 'Grep':
      return checkPath(ctx.worktree, input.path, true)
    case 'Glob': {
      const pattern = input.pattern
      if (typeof pattern !== 'string' || isAbsolute(pattern) || pattern.split(/[\\/]/).includes('..')) {
        return { allow: false, reason: 'Das Glob-Muster muss relativ sein und darf kein .. enthalten.' }
      }
      return checkPath(ctx.worktree, input.path, true)
    }
    case 'Write':
    case 'Edit':
      return ctx.mode === 'analyze' ? checkPath(ctx.worktree, input.file_path, false) : forbidden(tool)
    case 'Bash':
      if (ctx.mode !== 'analyze') return forbidden(tool)
      return typeof input.command === 'string' && input.command.trim() === ctx.testCommand
        ? ALLOW
        : { allow: false, reason: `Erlaubt ist nur das Testkommando, wörtlich: ${ctx.testCommand}` }
    case 'StructuredOutput':
      // Über dieses Tool liefert die Sitzung ihr Ergebnis nach `outputFormat`.
      return ALLOW
    default:
      return forbidden(tool)
  }
}

/** Tool und Kommando oder Pfad, für die Logzeile einer Ablehnung. */
export function describeCall(tool: string, input: Record<string, unknown>): string {
  const detail = [input.command, input.file_path, input.path, input.pattern].find((v) => typeof v === 'string')
  return detail === undefined ? tool : `${tool} (${String(detail)})`
}
