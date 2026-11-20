/** Ein Beitrag im Chat. Ebene 1 ist ein Top-Post, 2 eine Antwort darauf usw. */
export type Post = { level: number; text: string }

/** Ein Top-Post mit allen Antworten bis zum nächsten Top-Post. `index` zählt ab 0. */
export type Thread = { index: number; top: Post; replies: Post[] }

export type ChatEvent =
  | { kind: 'NewThread'; thread: Thread }
  | { kind: 'NewReply'; thread: Thread; reply: Post; replyIndex: number }

export type ThreadState = { topHash: string; replyCount: number; ticket: number | null }

/** Position im Array = Thread-Index. Lücken erscheinen in JSON als null. */
export type State = { threads: (ThreadState | null)[] }
