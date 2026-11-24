import type { Post, Thread } from './types.ts'

const POST_LINE = /^(>+) ?(.*)$/

/**
 * Zerlegt den Chat in Threads. Eine Zeile mit genau einem `>` beginnt einen
 * Top-Post, mehr `>` eine Antwort der entsprechenden Ebene. Zeilen ohne Präfix
 * gehören zum vorigen Post; vor dem ersten Top-Post wird alles ignoriert.
 */
export function parseChat(text: string): Thread[] {
  const threads: Thread[] = []
  let current: Post | undefined

  for (const line of text.split(/\r?\n/)) {
    const match = POST_LINE.exec(line)
    if (match === null) {
      if (current !== undefined) current.text += `\n${line}`
      continue
    }

    const post: Post = { level: match[1]!.length, text: match[2]! }
    if (post.level === 1) {
      threads.push({ id: String(threads.length), index: threads.length, top: post, replies: [] })
      current = post
      continue
    }

    const thread = threads.at(-1)
    if (thread === undefined) {
      current = undefined
      continue
    }
    thread.replies.push(post)
    current = post
  }

  for (const thread of threads) {
    for (const post of [thread.top, ...thread.replies]) post.text = post.text.trimEnd()
  }
  return threads
}

/** Gibt einen Post wieder im Chat-Format aus, mit Präfix vor jeder Zeile. */
export function formatPost(post: Post): string {
  const prefix = '>'.repeat(post.level)
  return post.text
    .split('\n')
    .map((line) => `${prefix} ${line}`)
    .join('\n')
}
