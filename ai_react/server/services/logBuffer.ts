// A fixed-size line buffer for a service's stdout/stderr. Bounded on purpose:
// a chatty service must not be able to grow the dev server's memory without
// limit, and a crash report only ever needs the last few lines.

export interface LogBuffer {
  /** Append a raw chunk; partial lines are held until their newline arrives. */
  push(chunk: string): void
  /** The last `lines` lines, newest last, joined by "\n". */
  tail(lines: number): string
  clear(): void
}

export function createLogBuffer(max = 200): LogBuffer {
  const lines: string[] = []
  let partial = ''

  return {
    push(chunk) {
      const parts = (partial + chunk).split('\n')
      partial = parts.pop() ?? ''
      for (const part of parts) {
        lines.push(part.replace(/\r$/, ''))
        if (lines.length > max) lines.shift()
      }
    },
    tail(count) {
      const all = partial.length > 0 ? [...lines, partial] : lines
      return all.slice(-count).join('\n')
    },
    clear() {
      lines.length = 0
      partial = ''
    },
  }
}
