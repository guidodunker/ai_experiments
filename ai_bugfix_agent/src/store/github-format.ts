import type { Ticket } from '../ticketfile.ts'
import { formatTimestamp } from '../tickets.ts'

/** Alle Issues des Agenten tragen dieses Label. */
export const AGENT_LABEL = 'bugfix-agent'

export type IssueData = { number: number; title: string; body: string; labels: string[]; url: string; open: boolean }
export type CommentData = { body: string; createdAt: string; login: string }
/** Kopffelder außer id, status und titel */
export type Meta = Record<string, string>

const KOPF_START = '<!-- bugfix-agent:kopf -->'
const KOPF_END = '<!-- /bugfix-agent:kopf -->'
const META_LINE = /^<!-- bugfix-agent (\{.*\}) -->$/m
const REPLY_MARK = /^<!-- bugfix-agent:nachtrag ebene=(\d+) -->\n?/
const SECTION_MARK = /^<!-- bugfix-agent:abschnitt (\S+) -->\n?/
/** Kopffelder vor bzw. nach `titel`, in der Reihenfolge des Dateiformats */
const BEFORE_TITLE = ['erstellt', 'thread', 'quelle', 'link']
const AFTER_TITLE = ['komponente', 'schweregrad', 'branch', 'test', 'kosten_analyse', 'kosten_plan']

function normalize(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

function cell(value: string): string {
  return value.replace(/\s*\n\s*/g, ' ').replaceAll('|', '\\|')
}

/** Tabelle für Menschen und JSON für den Agenten, beide aus denselben Werten */
export function renderKopf(meta: Meta): string {
  const costs = [
    meta.kosten_analyse === undefined ? undefined : `Analyse ${meta.kosten_analyse} $`,
    meta.kosten_plan === undefined ? undefined : `Plan ${meta.kosten_plan} $`,
  ].filter((part) => part !== undefined)
  const rows: [string, string | undefined][] = [
    ['Quelle', meta.quelle === 'slack' && meta.link !== undefined ? `[Slack-Thread](${meta.link})` : meta.quelle],
    ['Komponente', meta.komponente],
    ['Schweregrad', meta.schweregrad],
    ['Erstellt', meta.erstellt],
    ['Branch', meta.branch],
    ['Test', meta.test],
    ['Kosten', costs.length === 0 ? undefined : costs.join(', ')],
  ]
  // `>` als >, damit ein Wert mit `-->` den HTML-Kommentar nicht beendet.
  const json = JSON.stringify(meta).replaceAll('>', '\\u003e')
  return [
    KOPF_START,
    '| Feld | Wert |',
    '|---|---|',
    ...rows.flatMap(([key, value]) => (value === undefined || value === '' ? [] : [`| ${key} | ${cell(value)} |`])),
    `<!-- bugfix-agent ${json} -->`,
    KOPF_END,
  ].join('\n')
}

export function renderBody(meta: Meta, description: string, original: string): string {
  return `${renderKopf(meta)}\n\n## Beschreibung\n${description.trim()}\n\n## Originalmeldung\n${original.trim()}\n`
}

function kopfBounds(body: string, number: number): { start: number; end: number } {
  const start = body.indexOf(KOPF_START)
  const end = body.indexOf(KOPF_END)
  if (start === -1 || end < start) throw new Error(`Issue #${number}: Kopfblock fehlt.`)
  return { start, end: end + KOPF_END.length }
}

export function parseBody(raw: string, number: number): { meta: Meta; rest: string } {
  const body = normalize(raw)
  const { start, end } = kopfBounds(body, number)
  const match = META_LINE.exec(body.slice(start, end))
  let meta: unknown
  try {
    meta = JSON.parse(match?.[1] ?? '')
  } catch {
    throw new Error(`Issue #${number}: Kopfdaten ungültig.`)
  }
  if (typeof meta !== 'object' || meta === null || Object.values(meta).some((v) => typeof v !== 'string')) {
    throw new Error(`Issue #${number}: Kopfdaten ungültig.`)
  }
  return { meta: meta as Meta, rest: (body.slice(0, start) + body.slice(end)).trim() }
}

/** Ersetzt nur den Kopfblock; was Menschen im übrigen Body ändern, bleibt. */
export function replaceKopf(raw: string, meta: Meta, number: number): string {
  const body = normalize(raw)
  const { start, end } = kopfBounds(body, number)
  return body.slice(0, start) + renderKopf(meta) + body.slice(end)
}

export function replyComment(level: number, text: string): string {
  return `<!-- bugfix-agent:nachtrag ebene=${level} -->\n${text.trim()}`
}

/** `heading` ist ein festes Wort aus dem Code (Analyse, Plan). */
export function sectionComment(heading: string, text: string): string {
  return `<!-- bugfix-agent:abschnitt ${heading} -->\n## ${heading}\n${text.trim()}`
}

export function statusOf(labels: string[], number: number): string {
  const found = labels.filter((label) => label.startsWith('status:'))
  if (found.length !== 1) {
    throw new Error(`Issue #${number}: erwartet genau ein status:-Label, gefunden: ${found.join(', ') || 'keins'}`)
  }
  return found[0]!.slice('status:'.length)
}

/** Baut aus Issue und Kommentaren das Ticket, wie es die Schritte aus einer Datei kennen. */
export function toTicket(issue: IssueData, comments: CommentData[]): Ticket {
  const { meta, rest } = parseBody(issue.body, issue.number)
  const header = new Map<string, string>([
    ['id', String(issue.number)],
    ['status', statusOf(issue.labels, issue.number)],
  ])
  const setFrom = (keys: string[]): void => {
    for (const key of keys) {
      const value = meta[key]
      if (value !== undefined) header.set(key, value)
    }
  }
  setFrom(BEFORE_TITLE)
  header.set('titel', issue.title)
  setFrom(AFTER_TITLE)
  setFrom(Object.keys(meta).filter((key) => !BEFORE_TITLE.includes(key) && !AFTER_TITLE.includes(key)))

  const replies: string[] = []
  const sections = new Map<string, string>()
  const sorted = [...comments].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
  for (const comment of sorted) {
    const body = normalize(comment.body)
    const when = formatTimestamp(new Date(comment.createdAt))
    const reply = REPLY_MARK.exec(body)
    if (reply !== null) {
      replies.push(`### ${when} (Antwort, Ebene ${reply[1]})\n${body.slice(reply[0].length).trim()}`)
      continue
    }
    const section = SECTION_MARK.exec(body)
    if (section !== null) {
      // Löschen und neu setzen: Der jüngste Abschnitt gilt und steht hinten.
      sections.delete(section[1]!)
      sections.set(section[1]!, body.slice(section[0].length).trim())
      continue
    }
    if (body.startsWith('<!-- bugfix-agent')) continue
    replies.push(`### ${when} (GitHub-Kommentar von @${comment.login})\n${body.trim()}`)
  }

  const parts = [rest, '', '## Nachträge']
  for (const reply of replies) parts.push('', reply)
  for (const section of sections.values()) parts.push('', section)
  return { id: issue.number, header, body: `${parts.join('\n')}\n` }
}
