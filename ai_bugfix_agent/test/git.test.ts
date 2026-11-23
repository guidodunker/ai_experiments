import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addWorktree,
  branchExists,
  changedFiles,
  commitFile,
  deleteBranch,
  git,
  isGitRepo,
  removeWorktree,
} from '../src/git.ts'
import { createRepo } from './helpers/repo.ts'

async function worktreeDir(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'bugagent-wt-')), 'wt')
}

test('isGitRepo erkennt Repo, Ordner ohne Git und fehlenden Pfad', async () => {
  assert.equal(await isGitRepo(await createRepo({ 'a.txt': 'a' })), true)
  assert.equal(await isGitRepo(await mkdtemp(join(tmpdir(), 'bugagent-plain-'))), false)
  assert.equal(await isGitRepo(join(tmpdir(), 'gibt-es-nicht-4711')), false)
})

test('addWorktree mit Basis legt Branch und Worktree an', async () => {
  const repo = await createRepo({ 'a.txt': 'a' })
  const wt = await worktreeDir()
  assert.equal(await branchExists(repo, 'bugfix/bug-1'), false)
  await addWorktree(repo, wt, 'bugfix/bug-1', 'main')
  assert.equal(await branchExists(repo, 'bugfix/bug-1'), true)
  assert.equal(existsSync(join(wt, 'a.txt')), true)
})

test('changedFiles nennt neue und geänderte Dateien mit /', async () => {
  const repo = await createRepo({ 'a.txt': 'a' })
  const wt = await worktreeDir()
  await addWorktree(repo, wt, 'bugfix/bug-1', 'main')
  await writeFile(join(wt, 'a.txt'), 'geändert')
  await mkdir(join(wt, 'test'))
  await writeFile(join(wt, 'test', 'neu.test.mjs'), 'x')
  assert.deepEqual((await changedFiles(wt)).sort(), ['a.txt', 'test/neu.test.mjs'])
})

test('commitFile committet eine Datei auf den Branch des Worktrees', async () => {
  const repo = await createRepo({ 'a.txt': 'a' })
  const wt = await worktreeDir()
  await addWorktree(repo, wt, 'bugfix/bug-1', 'main')
  await writeFile(join(wt, 'b.txt'), 'b')
  await commitFile(wt, 'b.txt', 'bug 1: roter Test')
  assert.deepEqual(await changedFiles(wt), [])
  assert.equal((await git(repo, ['rev-list', '--count', 'main..bugfix/bug-1'])).trim(), '1')
})

test('removeWorktree räumt auf und verträgt fehlende Worktrees', async () => {
  const repo = await createRepo({ 'a.txt': 'a' })
  const wt = await worktreeDir()
  await removeWorktree(repo, wt)
  await addWorktree(repo, wt, 'bugfix/bug-1', 'main')
  await writeFile(join(wt, 'schmutz.txt'), 'x')
  await removeWorktree(repo, wt)
  assert.equal(existsSync(wt), false)
  await deleteBranch(repo, 'bugfix/bug-1')
  assert.equal(await branchExists(repo, 'bugfix/bug-1'), false)
})

test('addWorktree ohne Basis nutzt den vorhandenen Branch', async () => {
  const repo = await createRepo({ 'a.txt': 'a' })
  await git(repo, ['branch', 'bugfix/bug-2'])
  const wt = await worktreeDir()
  await addWorktree(repo, wt, 'bugfix/bug-2')
  assert.equal((await git(wt, ['branch', '--show-current'])).trim(), 'bugfix/bug-2')
})
