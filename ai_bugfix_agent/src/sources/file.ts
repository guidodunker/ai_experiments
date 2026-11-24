import { readFile } from 'node:fs/promises'
import { parseChat } from '../parser.ts'
import { isNotFound } from '../state.ts'
import type { ChatReply } from '../types.ts'
import { watchChat } from '../watch.ts'
import type { ChatSource } from './types.ts'

/** Editoren speichern auch halb getippte Zeilen; erst nach einer Tipp-Pause auswerten. */
export const FILE_DEBOUNCE_MS = 3000

export function fileSource(chatPath: string, debounceMs = FILE_DEBOUNCE_MS): ChatSource {
  return {
    name: 'datei',
    label: chatPath,
    async readThreads() {
      try {
        return parseChat(await readFile(chatPath, 'utf8'))
      } catch (error) {
        if (isNotFound(error)) return 'missing'
        throw error
      }
    },
    watch(onChange) {
      watchChat(chatPath, onChange, debounceMs)
    },
  }
}

/** Eine Datei hat keinen Rückkanal: Die Antwort steht nur im Log. */
export function fileReply(log: (message: string) => void): ChatReply {
  return async (threadId, text) => log(`Antwort an Thread ${threadId}: ${text}`)
}
