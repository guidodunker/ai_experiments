import type { SourceName, Thread } from '../types.ts'

/** Woher der Chat kommt. Ein Lauf liest immer den vollständigen Stand. */
export type ChatSource = {
  name: SourceName
  /** Für Log-Zeilen, z. B. der Dateipfad oder der Channel */
  label: string
  /** Vollständiger Stand. 'missing', wenn die Datei fehlt. */
  readThreads(): Promise<Thread[] | 'missing'>
  /** Ruft onChange bei jeder Änderung auf, entprellt. Hält den Prozess am Leben. */
  watch(onChange: () => void): void
}
