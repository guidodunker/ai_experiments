import { appendFileSync } from 'node:fs'
import { formatTimestamp } from './tickets.ts'

/** Konsole und Logdatei; dort stehen auch die Begründungen der Modelle. */
export function createLog(file: string): (message: string) => void {
  return (message) => {
    process.stderr.write(`${message}\n`)
    appendFileSync(file, `${formatTimestamp(new Date())} ${message}\n`)
  }
}
