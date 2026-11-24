import type { CommentData, IssueData } from '../../src/store/github-format.ts'
import type { GitHubApi } from '../../src/store/github.ts'

/** GitHub im Speicher. Kommentare bekommen aufsteigende Zeitstempel. */
export function fakeGitHub() {
  const issues = new Map<number, IssueData>()
  const comments = new Map<number, CommentData[]>()
  const labels = new Set<string>()
  let next = 1
  let clock = 0
  const copy = (issue: IssueData): IssueData => ({ ...issue, labels: [...issue.labels] })
  const api: GitHubApi = {
    repo: 'o/r',
    getRepo: async () => {},
    ensureLabels: async (names) => {
      for (const name of names) labels.add(name)
    },
    createIssue: async ({ title, body, labels: issueLabels }) => {
      const number = next++
      const issue = { number, title, body, labels: [...issueLabels], url: `https://github.com/o/r/issues/${number}`, open: true }
      issues.set(number, issue)
      return copy(issue)
    },
    getIssue: async (number) => {
      const issue = issues.get(number)
      return issue === undefined ? undefined : copy(issue)
    },
    updateBody: async (number, body) => {
      issues.get(number)!.body = body
    },
    setLabels: async (number, issueLabels) => {
      issues.get(number)!.labels = [...issueLabels]
    },
    listComments: async (number) => [...(comments.get(number) ?? [])],
    addComment: async (number, body) => {
      const list = comments.get(number) ?? []
      list.push({ body, login: 'bugfix-bot', createdAt: new Date(Date.UTC(2026, 10, 24, 9, 0, clock++)).toISOString() })
      comments.set(number, list)
    },
    listOpenIssues: async (label) => [...issues.values()].filter((i) => i.open && i.labels.includes(label)).map(copy),
  }
  return { api, issues, comments, labels }
}
