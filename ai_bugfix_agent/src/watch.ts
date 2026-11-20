import { watch, type FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'

/**
 * Sorgt dafür, dass nie zwei Läufe parallel laufen. Wird während eines Laufs
 * ausgelöst, folgt genau ein weiterer Lauf, egal wie oft ausgelöst wurde.
 */
export function createSerialRunner(
  run: () => Promise<void>,
  onError: (error: unknown) => void,
): () => Promise<void> {
  let running = false
  let pending = false

  return async function trigger(): Promise<void> {
    if (running) {
      pending = true
      return
    }
    running = true
    try {
      do {
        pending = false
        try {
          await run()
        } catch (error) {
          onError(error)
        }
      } while (pending)
    } finally {
      running = false
    }
  }
}

/**
 * Beobachtet das Verzeichnis statt der Datei: so funktioniert es auch, wenn
 * die Datei noch fehlt oder ein Editor sie beim Speichern ersetzt.
 */
export function watchChat(chatPath: string, onChange: () => void, debounceMs: number): FSWatcher {
  const name = basename(chatPath)
  let timer: NodeJS.Timeout | undefined
  return watch(dirname(chatPath), (_type, filename) => {
    if (filename !== null && filename !== name) return
    clearTimeout(timer)
    timer = setTimeout(onChange, debounceMs)
  })
}
