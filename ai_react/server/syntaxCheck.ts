// Syntax gate for agent writes: code that cannot even be parsed never reaches
// disk, so the running app can never die from a half-written file. Type errors
// are deliberately NOT checked here — an intermediate state where App.tsx
// imports a component that is written one tool call later is legitimate. Those
// are caught at the end of the turn by server/tscCheck.ts.

import ts from 'typescript'

const CHECKED = /\.(ts|tsx|js|jsx|mts|cts)$/i

function lineCol(content: string, pos: number): { line: number; col: number } {
  const lines = content.slice(0, pos).split('\n')
  return { line: lines.length, col: (lines[lines.length - 1]?.length ?? 0) + 1 }
}

/**
 * Returns null when `content` parses (or is not a JS/TS file), otherwise a
 * message naming the first syntax error with its 1-based line and column.
 */
export function checkSyntax(relPath: string, content: string): string | null {
  if (!CHECKED.test(relPath)) return null

  const { diagnostics } = ts.transpileModule(content, {
    reportDiagnostics: true,
    fileName: relPath,
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
    },
  })

  const first = diagnostics?.[0]
  if (!first) return null

  const message = ts.flattenDiagnosticMessageText(first.messageText, ' ')
  if (first.start === undefined) return `Syntax error in ${relPath}: ${message}`
  const { line, col } = lineCol(content, first.start)
  return `Syntax error in ${relPath} (line ${line}, column ${col}): ${message}`
}
