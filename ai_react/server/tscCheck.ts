// Full type check of the app project. This is the thorough second pass behind
// the module probe: it sees type errors the browser never notices (Vite strips
// types without checking them), which break `npm run build` later on.
//
// Runtime measured on this project: ~3.0 s warm, ~8.8 s cold.

import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface TypeDiagnostic {
  file: string
  line: number
  col: number
  code: string
  message: string
}

// tsc's non-pretty format: src/App.tsx(12,7): error TS2304: Cannot find name 'x'.
const DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.*)$/

export function parseTscOutput(stdout: string): TypeDiagnostic[] {
  const diagnostics: TypeDiagnostic[] = []
  for (const raw of stdout.split(/\r?\n/)) {
    const match = DIAGNOSTIC.exec(raw.trim())
    if (!match) continue
    diagnostics.push({
      file: match[1].split('\\').join('/'),
      line: Number(match[2]),
      col: Number(match[3]),
      code: match[4],
      message: match[5],
    })
  }
  return diagnostics
}

let inFlight: Promise<TypeDiagnostic[]> | null = null

/**
 * Type-check the app project. Concurrent callers share one tsc run instead of
 * starting a second compiler — the check is the slowest part of the turn gate.
 */
export function runTypecheck(root: string): Promise<TypeDiagnostic[]> {
  if (!inFlight) {
    inFlight = execTypecheck(root).finally(() => {
      inFlight = null
    })
  }
  return inFlight
}

async function execTypecheck(root: string): Promise<TypeDiagnostic[]> {
  const bin = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')
  try {
    await execFileAsync(
      process.execPath,
      [bin, '--noEmit', '--incremental', '--pretty', 'false', '-p', 'tsconfig.app.json'],
      { cwd: root, maxBuffer: 8 * 1024 * 1024 },
    )
    return []
  } catch (err) {
    // tsc exits non-zero when it found errors; the diagnostics are on stdout.
    const stdout = (err as { stdout?: string }).stdout ?? ''
    const diagnostics = parseTscOutput(stdout)
    if (diagnostics.length > 0) return diagnostics
    // Non-zero without parsable diagnostics means tsc itself failed to run.
    return [
      {
        file: 'tsconfig.app.json',
        line: 0,
        col: 0,
        code: 'TSC',
        message: `tsc could not run: ${String((err as Error).message ?? err).slice(0, 200)}`,
      },
    ]
  }
}
