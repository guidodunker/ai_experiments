import { formatPost } from '../parser.ts'
import type { Ticket } from '../ticketfile.ts'
import { formatTimestamp, oneLine } from '../tickets.ts'
import {
  AGENT_LABEL,
  parseBody,
  renderBody,
  replaceKopf,
  replyComment,
  sectionComment,
  toTicket,
  type CommentData,
  type IssueData,
  type Meta,
} from './github-format.ts'
import type { TicketStore } from './types.ts'

/** Die REST-Aufrufe für ein Repo. Echt in `github-client.ts`, in Tests ein Fake. */
export type GitHubApi = {
  repo: string
  /** Wirft, wenn Token oder Repo nicht stimmen */
  getRepo(): Promise<void>
  /** Legt fehlende Labels an */
  ensureLabels(names: string[]): Promise<void>
  createIssue(input: { title: string; body: string; labels: string[] }): Promise<IssueData>
  /** undefined bei 404 */
  getIssue(number: number): Promise<IssueData | undefined>
  updateBody(number: number, body: string): Promise<void>
  /** Ersetzt alle Labels */
  setLabels(number: number, labels: string[]): Promise<void>
  /** Alle Seiten, älteste zuerst */
  listComments(number: number): Promise<CommentData[]>
  addComment(number: number, body: string): Promise<void>
  /** Offene Issues mit dem Label, alle Seiten, ohne Pull Requests */
  listOpenIssues(label: string): Promise<IssueData[]>
}

/** Labels haben höchstens 50 Zeichen. */
function labelFor(prefix: string, value: string): string {
  return `${prefix}:${value}`.slice(0, 50)
}

export function githubStore(api: GitHubApi): TicketStore {
  async function ownIssue(id: number): Promise<IssueData | undefined> {
    const issue = await api.getIssue(id)
    return issue !== undefined && issue.labels.includes(AGENT_LABEL) ? issue : undefined
  }

  async function mustGet(id: number): Promise<IssueData> {
    const issue = await ownIssue(id)
    if (issue === undefined) throw new Error(`Issue #${id} gibt es nicht oder es gehört nicht zum Agenten.`)
    return issue
  }

  async function read(id: number): Promise<Ticket> {
    const issue = await mustGet(id)
    return toTicket(issue, await api.listComments(id))
  }

  return {
    kind: 'github',
    label: (id) => `#${id}`,
    branch: (id) => `bugfix/issue-${id}`,

    async create(thread, fields, source, now, link) {
      const component = oneLine(fields.component)
      const meta: Meta = {
        erstellt: formatTimestamp(now),
        thread: thread.id,
        quelle: source,
        ...(link === undefined ? {} : { link: oneLine(link) }),
        komponente: component,
        schweregrad: fields.severity,
      }
      const labels = [AGENT_LABEL, 'status:neu', labelFor('komponente', component), labelFor('schweregrad', fields.severity)]
      await api.ensureLabels(labels)
      const issue = await api.createIssue({
        title: oneLine(fields.title),
        body: renderBody(meta, fields.description, formatPost(thread.top)),
        labels,
      })
      return { id: issue.number, url: issue.url }
    },

    async appendReply(id, entry) {
      if ((await ownIssue(id)) === undefined) return false
      await api.addComment(id, replyComment(entry.level, entry.text))
      return true
    },

    async list() {
      return (await api.listOpenIssues(AGENT_LABEL)).map((issue) => issue.number).sort((a, b) => a - b)
    },

    read,

    async applyResult(id, result) {
      const issue = await mustGet(id)
      const status = `status:${result.status}`
      await api.ensureLabels([status])
      await api.setLabels(id, [...issue.labels.filter((label) => !label.startsWith('status:')), status])
      if (result.fields !== undefined && Object.keys(result.fields).length > 0) {
        const { meta } = parseBody(issue.body, id)
        await api.updateBody(id, replaceKopf(issue.body, { ...meta, ...result.fields }, id))
      }
      if (result.section !== undefined) {
        await api.addComment(id, sectionComment(result.section.heading, result.section.text))
      }
      return read(id)
    },
  }
}
