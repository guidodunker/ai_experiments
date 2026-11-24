import { join } from 'node:path'
import { fileStore } from './file.ts'
import { githubClient } from './github-client.ts'
import { githubStore, type GitHubApi } from './github.ts'
import type { TicketStore } from './types.ts'

type Env = Record<string, string | undefined>

const GITHUB_SETTINGS = ['GITHUB_TOKEN', 'GITHUB_REPO'] as const

function setting(env: Env, name: string): string | undefined {
  const value = env[name]?.trim()
  return value === undefined || value === '' ? undefined : value
}

/** Wählt die Ablage nach `TICKET_STORE`. Bei GitHub prüft ein Aufruf sofort Token und Repo. */
export async function chooseStore(
  env: Env,
  root: string,
  makeApi: (token: string, repo: string) => GitHubApi = githubClient,
): Promise<TicketStore | { error: string }> {
  const name = setting(env, 'TICKET_STORE') ?? 'datei'
  if (name === 'datei') return fileStore(join(root, 'tickets'))
  if (name !== 'github') return { error: `TICKET_STORE=${name} ist unbekannt. Erlaubt: datei, github.` }

  const missing = GITHUB_SETTINGS.find((key) => setting(env, key) === undefined)
  if (missing !== undefined) return { error: `${missing} fehlt. Trage es in .env ein (siehe .env.example).` }
  const repo = setting(env, 'GITHUB_REPO')!
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { error: `GITHUB_REPO=${repo} hat nicht die Form owner/name.` }

  const api = makeApi(setting(env, 'GITHUB_TOKEN')!, repo)
  try {
    await api.getRepo()
  } catch (error) {
    return { error: `GitHub-Repo ${repo} nicht erreichbar: ${error instanceof Error ? error.message : String(error)}` }
  }
  return githubStore(api)
}
