import { join } from 'node:path'
import { withoutSecrets } from '../command.ts'

type Env = Record<string, string | undefined>

export type Backend = 'openrouter' | 'claude-login'

const BACKENDS: Backend[] = ['openrouter', 'claude-login']
const DEFAULT_MODEL: Record<Backend, string> = {
  openrouter: 'anthropic/claude-opus-5',
  'claude-login': 'claude-opus-5',
}

export type BackendChoice = {
  backend: Backend
  model: string
  /** Umgebung der Sitzung, immer ohne Geheimnisse */
  sessionEnv: Env
  /** Eigenes Claude-Code-Verzeichnis, muss vor der Sitzung existieren */
  configDir?: string
}

function setting(env: Env, name: string): string | undefined {
  const value = env[name]?.trim()
  return value === undefined || value === '' ? undefined : value
}

/**
 * Wer die Sitzungen bezahlt. Bei `openrouter` sieht die Sitzung den
 * Claude-Code-Login nicht: eigenes, leeres Konfigurationsverzeichnis und leerer
 * ANTHROPIC_API_KEY. Stimmt der Token nicht, scheitert sie, statt auszuweichen.
 * Tokens für GitHub und Slack bekommt die Sitzung in keinem Fall.
 */
export function chooseBackend(env: Env, root: string): BackendChoice | { error: string } {
  const name = setting(env, 'STEPS_BACKEND') ?? 'openrouter'
  if (!BACKENDS.includes(name as Backend)) {
    return { error: `STEPS_BACKEND=${name} ist unbekannt. Erlaubt: ${BACKENDS.join(', ')}.` }
  }
  const backend = name as Backend
  const model = setting(env, 'STEPS_MODEL') ?? DEFAULT_MODEL[backend]
  if (backend === 'claude-login') {
    const apiKey = setting(env, 'ANTHROPIC_API_KEY')
    return {
      backend,
      model,
      sessionEnv: { ...withoutSecrets(env), ...(apiKey === undefined ? {} : { ANTHROPIC_API_KEY: apiKey }) },
    }
  }

  const key = setting(env, 'OPENROUTER_API_KEY')
  if (key === undefined) {
    return { error: 'OPENROUTER_API_KEY fehlt. npm run steps läuft über OpenRouter (STEPS_BACKEND=openrouter).' }
  }
  const configDir = join(root, '.claude-steps')
  return {
    backend,
    model,
    configDir,
    sessionEnv: {
      ...withoutSecrets(env),
      ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
      ANTHROPIC_AUTH_TOKEN: key,
      ANTHROPIC_API_KEY: '',
      CLAUDE_CONFIG_DIR: configDir,
    },
  }
}
