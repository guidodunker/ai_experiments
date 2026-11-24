import { runFile } from '../command.ts'
import type { GitHubApi } from '../store/github.ts'

export type PullInput = { title: string; head: string; base: string; body: string }

/** Push und Pull Request. Echt über GitHub, in Tests gegen ein lokales Bare-Repo. */
export type Publisher = {
  /** Commit des Branches auf dem Remote, undefined wenn es ihn dort nicht gibt */
  remoteHead(branch: string): Promise<string | undefined>
  push(worktree: string, branch: string): Promise<void>
  findOpenPull(branch: string): Promise<string | undefined>
  createPull(input: PullInput): Promise<string>
}

function basicAuth(token: string): string {
  return Buffer.from(`x-access-token:${token}`).toString('base64')
}

/**
 * Der Token geht über Git-Konfiguration aus Umgebungsvariablen an Git, nicht
 * über die Kommandozeile. Der Credential-Helper bleibt aus, damit kein Dialog
 * aufgeht und keine gespeicherten Zugangsdaten des Rechners greifen.
 */
export function pushAuth(token: string): { args: string[]; env: NodeJS.ProcessEnv } {
  return {
    args: ['-c', 'credential.helper='],
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${basicAuth(token)}`,
    },
  }
}

export function redact(text: string, token: string): string {
  return text.replaceAll(token, '***').replaceAll(basicAuth(token), '***')
}

export function githubPublisher(
  token: string,
  githubRepo: string,
  pulls: Pick<GitHubApi, 'findOpenPull' | 'createPull'>,
  options: { url?: string } = {},
): Publisher {
  // Nicht `origin`: gepusht wird nur dorthin, wofür der Token gilt.
  const url = options.url ?? `https://github.com/${githubRepo}.git`
  const auth = pushAuth(token)

  async function gitWithToken(cwd: string, args: string[], what: string): Promise<string> {
    const result = await runFile('git', [...auth.args, ...args], cwd, auth.env)
    if (result.code !== 0) throw new Error(redact(`git ${what} fehlgeschlagen:\n${result.output.trim()}`, token))
    return result.stdout
  }

  return {
    async remoteHead(branch) {
      const out = await gitWithToken(process.cwd(), ['ls-remote', url, `refs/heads/${branch}`], 'ls-remote')
      return out.trim().split(/\s+/)[0] || undefined
    },
    async push(worktree, branch) {
      // Ohne --force: Weicht der Branch auf GitHub ab, scheitert der Push.
      await gitWithToken(worktree, ['push', url, `refs/heads/${branch}:refs/heads/${branch}`], 'push')
    },
    findOpenPull: (branch) => pulls.findOpenPull(branch),
    createPull: (input) => pulls.createPull(input),
  }
}
