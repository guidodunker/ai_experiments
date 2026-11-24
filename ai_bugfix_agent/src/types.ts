/** Ein Beitrag im Chat. Ebene 1 ist ein Top-Post, 2 eine Antwort darauf usw. */
export type Post = { level: number; text: string }

/**
 * Ein Top-Post mit allen Antworten. `id` erkennt den Thread über Läufe hinweg
 * wieder: in `chat.txt` die Position, in Slack der `ts` des Top-Posts.
 * `index` zählt ab 0 in der aktuellen Reihenfolge und dient nur Log-Zeilen.
 */
export type Thread = { id: string; index: number; top: Post; replies: Post[] }

export type ChatEvent =
  | { kind: 'NewThread'; thread: Thread }
  | { kind: 'NewReply'; thread: Thread; reply: Post; replyIndex: number }

export type ThreadState = { topHash: string; replyCount: number; ticket: number | null }

export type SourceName = 'datei' | 'slack'

/** Antwortet im Thread mit dieser ID. Wirft bei einem Fehler. */
export type ChatReply = (threadId: string, text: string) => Promise<void>

/** Schlüssel ist die Thread-ID. */
export type State = { threads: Record<string, ThreadState> }
