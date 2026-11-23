import { spawn, type ChildProcess } from 'node:child_process'

/** `output` enthält stdout und stderr in der Reihenfolge des Eintreffens. */
export type CommandResult = { code: number; stdout: string; output: string }

/** Ein hängender Test soll den Lauf nicht blockieren. */
const TIMEOUT_MS = 5 * 60 * 1000

function collect(child: ChildProcess): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let output = ''
    // Eigener Timer statt der spawn-Option `timeout`: Deren Timer bleibt stehen,
    // wenn der Prozess gar nicht startet, und hält dann Node am Leben.
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS)
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      output += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      // Ohne Exit-Code (Abbruch durch Signal, Timeout) gilt der Lauf als fehlgeschlagen.
      resolve({ code: code ?? 1, stdout, output })
    })
  })
}

/** Führt eine Kommandozeile über die Shell aus, z. B. das Testkommando des Ziel-Repos. */
export function runShell(command: string, cwd: string): Promise<CommandResult> {
  // Läuft dieser Prozess selbst unter `node --test`, hielte sich ein `node --test`
  // des Ziel-Repos für einen Teilprozess davon und meldete Erfolg trotz roter Tests.
  const { NODE_TEST_CONTEXT: _ignored, ...env } = process.env
  return collect(spawn(command, { cwd, shell: true, env }))
}

/** Führt ein Programm ohne Shell aus; Argumente werden nicht interpretiert. */
export function runFile(file: string, args: string[], cwd: string): Promise<CommandResult> {
  return collect(spawn(file, args, { cwd }))
}

/** Die letzten `count` Zeilen, ohne Leerzeilen am Ende. */
export function tailLines(text: string, count: number): string {
  return text.trimEnd().split(/\r?\n/).slice(-count).join('\n')
}
