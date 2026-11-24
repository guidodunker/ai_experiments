import { rm } from 'node:fs/promises'
import { runFile } from './command.ts'

/** Commits des Agenten tragen eine feste Identität, unabhängig von der Git-Konfiguration des Rechners. */
const IDENTITY = ['-c', 'user.name=bugfix-agent', '-c', 'user.email=bugfix-agent@localhost']

/** Führt git in `cwd` aus und liefert stdout. Wirft bei Exit-Code ungleich 0. */
export async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runFile('git', args, cwd)
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} fehlgeschlagen:\n${result.output.trim()}`)
  return result.stdout
}

export async function isGitRepo(path: string): Promise<boolean> {
  try {
    return (await git(path, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true'
  } catch {
    return false
  }
}

export async function initRepo(path: string): Promise<void> {
  await git(path, ['init', '-b', 'main'])
}

export async function branchExists(repo: string, branch: string): Promise<boolean> {
  const result = await runFile('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repo)
  return result.code === 0
}

/** Mit `base` auf einem neuen Branch ab `base`, sonst auf dem vorhandenen Branch. */
export async function addWorktree(repo: string, path: string, branch: string, base?: string): Promise<void> {
  await git(
    repo,
    base === undefined ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path, base],
  )
}

/** Entfernt einen Worktree, auch einen halb angelegten oder schon gelöschten. */
export async function removeWorktree(repo: string, path: string): Promise<void> {
  // Schlägt fehl, wenn git den Worktree nicht kennt; dann bleibt nur das Verzeichnis.
  await runFile('git', ['worktree', 'remove', '--force', path], repo)
  await rm(path, { recursive: true, force: true })
  await git(repo, ['worktree', 'prune'])
}

export async function deleteBranch(repo: string, branch: string): Promise<void> {
  await git(repo, ['branch', '-D', branch])
}

/** Geänderte und neue Dateien relativ zum Repo, mit `/` getrennt. */
export async function changedFiles(worktree: string): Promise<string[]> {
  const output = await git(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  // Jeder Eintrag: zwei Statuszeichen, Leerzeichen, Pfad.
  return output
    .split('\0')
    .filter((entry) => entry !== '')
    .map((entry) => entry.slice(3))
}

export async function commitFile(worktree: string, file: string, message: string): Promise<void> {
  await git(worktree, ['add', '--', file])
  await git(worktree, [...IDENTITY, 'commit', '-m', message])
}

/** Committet nur, was unter `path` vorgemerkt ist; andere vorgemerkte Änderungen bleiben liegen. */
export async function commitPath(repo: string, path: string, message: string): Promise<void> {
  await git(repo, [...IDENTITY, 'commit', '-q', '-m', message, '--', path])
}

export async function commitAll(repo: string, message: string): Promise<void> {
  await git(repo, ['add', '-A'])
  await git(repo, [...IDENTITY, 'commit', '-m', message])
}
