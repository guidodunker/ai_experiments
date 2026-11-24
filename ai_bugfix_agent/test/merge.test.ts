import { test } from 'node:test'
import assert from 'node:assert/strict'
import { branchExists, git } from '../src/git.ts'
import { createMergeStep, type MergeGitHub } from '../src/steps/merge.ts'
import { parseTicket } from '../src/ticketfile.ts'
import { createRepo } from './helpers/repo.ts'

const ticket = parseTicket(
  'id: 7\nstatus: freigegeben\ntitel: Summe falsch\nbranch: bugfix/issue-7\npr: https://github.com/o/r/pull/3\n\n## Fix\n',
)

async function setup(overrides: Partial<MergeGitHub> = {}) {
  const repo = await createRepo({ 'a.txt': 'a\n' })
  await git(repo, ['branch', 'bugfix/issue-7'])
  const merges: [number, string][] = []
  const deleted: string[] = []
  const closed: number[] = []
  const logs: string[] = []
  const github: MergeGitHub = {
    getPull: async () => ({ state: 'open', merged: false }),
    mergePull: async (number, title) => (merges.push([number, title]), { merged: true, sha: 'abc123' }),
    deleteBranch: async (branch) => void deleted.push(branch),
    ...overrides,
  }
  const step = createMergeStep({
    repo,
    base: 'ai-bugfix-agent',
    github,
    closeTicket: async (id) => void closed.push(id),
    label: (id) => `#${id}`,
    log: (m) => logs.push(m),
  })
  return { repo, step, merges, deleted, closed, logs }
}

test('Erfolg: Squash mit Titel, Branches gelöscht, Ticket geschlossen, erledigt', async () => {
  const env = await setup()
  const result = await env.step.run(ticket)
  assert.equal(result.status, 'erledigt')
  assert.deepEqual(result.fields, { merge_commit: 'abc123' })
  assert.equal(result.summary, 'gemergt in ai-bugfix-agent: https://github.com/o/r/pull/3')
  assert.match(result.section?.text ?? '', /### Merge-Commit\nabc123/)
  assert.deepEqual(env.merges, [[3, 'Fix #7: Summe falsch (#3)']])
  assert.deepEqual(env.deleted, ['bugfix/issue-7'])
  assert.equal(await branchExists(env.repo, 'bugfix/issue-7'), false)
  assert.deepEqual(env.closed, [7])
})

test('PR schon gemergt: kein zweiter Merge, erledigt', async () => {
  const env = await setup({ getPull: async () => ({ state: 'closed', merged: true, mergeCommit: 'def456' }) })
  const result = await env.step.run(ticket)
  assert.equal(result.status, 'erledigt')
  assert.deepEqual(result.fields, { merge_commit: 'def456' })
  assert.deepEqual(env.merges, [])
  assert.deepEqual(env.closed, [7])
})

test('PR geschlossen ohne Merge: merge_gescheitert', async () => {
  const env = await setup({ getPull: async () => ({ state: 'closed', merged: false }) })
  const result = await env.step.run(ticket)
  assert.equal(result.status, 'merge_gescheitert')
  assert.equal(result.summary, 'PR #3 ist geschlossen.')
  assert.deepEqual(env.closed, [])
})

test('PR nicht mergebar: merge_gescheitert mit Meldung', async () => {
  const env = await setup({ mergePull: async () => ({ merged: false, message: 'Pull Request is not mergeable' }) })
  const result = await env.step.run(ticket)
  assert.equal(result.status, 'merge_gescheitert')
  assert.equal(result.summary, 'PR #3 ließ sich nicht mergen: Pull Request is not mergeable')
  assert.equal(await branchExists(env.repo, 'bugfix/issue-7'), true)
})

test('Feld pr fehlt: Fehler', async () => {
  const env = await setup()
  const withoutPr = parseTicket('id: 7\nstatus: freigegeben\ntitel: X\n\n')
  await assert.rejects(env.step.run(withoutPr), /kein Kopffeld pr/)
})

test('Branch löschen scheitert: Warnung, trotzdem erledigt', async () => {
  const env = await setup({
    deleteBranch: async () => {
      throw new Error('Reference does not exist')
    },
  })
  const result = await env.step.run(ticket)
  assert.equal(result.status, 'erledigt')
  assert.ok(
    env.logs.includes('Warnung: Branch bugfix/issue-7 auf GitHub nicht gelöscht: Reference does not exist'),
    env.logs.join('\n'),
  )
})
