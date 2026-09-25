// Schema, validation and on-disk I/O for service manifests. The validation half
// is pure so it can be unit-tested; the fs half is four thin helpers at the end.
//
// Manifests are SERVER-OWNED: the agent proposes intent through create_service,
// this module decides what is legal, and server/agentPlugin.ts refuses any
// write_file that targets services/<name>/service.json.

import fs from 'node:fs/promises'
import path from 'node:path'

/** 'container' joins this union in M2; the Runnable indirection exists for it. */
export type ServiceKind = 'process'

export interface HealthSpec {
  /** Path polled until it answers 200, e.g. "/health". */
  path: string
  timeoutMs: number
}

export interface Manifest {
  name: string
  kind: ServiceKind
  entry: string
  /** Host port. Always assigned by the allocator, never by the model. */
  port: number
  env: Record<string, string>
  /** false = stopped by hand; reconcile and the health gate leave it alone. */
  enabled: boolean
  health: HealthSpec
}

export interface ManifestInput {
  name?: unknown
  kind?: unknown
  entry?: unknown
  env?: unknown
  health?: unknown
}

/** Every rejection the agent sees comes from here, so messages are actionable. */
export class ManifestError extends Error {}

const NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/
const ENTRY_RE = /^[A-Za-z0-9_-]+\.(ts|js|mjs)$/
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]*$/
// NODE_OPTIONS could inject --allow-fs-write and defeat the permission model;
// PORT belongs to the supervisor. Neither may come from the model.
const ENV_DENY_RE = /^(NODE_|PORT$|ELECTRON_)/
export const DEFAULT_HEALTH_PATH = '/health'
export const DEFAULT_HEALTH_TIMEOUT_MS = 10_000

export function validateName(value: unknown): string {
  if (typeof value !== 'string' || value.length < 3 || value.length > 32 || !NAME_RE.test(value)) {
    throw new ManifestError(
      `Invalid service name ${JSON.stringify(value)} — use 3 to 32 characters: ` +
        'lowercase letters, digits and single dashes, starting with a letter.',
    )
  }
  return value
}

function validateKind(value: unknown): ServiceKind {
  if (value !== 'process') {
    throw new ManifestError(`Invalid kind ${JSON.stringify(value)} — only "process" is supported.`)
  }
  return value
}

function validateEntry(value: unknown): string {
  if (typeof value !== 'string' || !ENTRY_RE.test(value)) {
    throw new ManifestError(
      `Invalid entry ${JSON.stringify(value)} — a single file name inside the service ` +
        'directory, such as "index.ts". Sub-paths are not allowed.',
    )
  }
  return value
}

function validateEnv(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ManifestError('env must be an object mapping UPPER_SNAKE_CASE keys to strings.')
  }
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!ENV_KEY_RE.test(key)) {
      throw new ManifestError(`Invalid env key ${JSON.stringify(key)} — use UPPER_SNAKE_CASE.`)
    }
    if (ENV_DENY_RE.test(key)) {
      throw new ManifestError(`env key ${key} is reserved and cannot be set by a service.`)
    }
    if (typeof raw !== 'string') throw new ManifestError(`env.${key} must be a string.`)
    out[key] = raw
  }
  return out
}

function validateHealth(value: unknown): HealthSpec {
  if (value === undefined || value === null) {
    return { path: DEFAULT_HEALTH_PATH, timeoutMs: DEFAULT_HEALTH_TIMEOUT_MS }
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ManifestError('health must be an object with "path" and optional "timeoutMs".')
  }
  const { path: healthPath, timeoutMs } = value as { path?: unknown; timeoutMs?: unknown }
  if (typeof healthPath !== 'string' || !healthPath.startsWith('/')) {
    throw new ManifestError(`Invalid health.path ${JSON.stringify(healthPath)} — must start with "/".`)
  }
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== 'number' || timeoutMs < 500 || timeoutMs > 120_000)
  ) {
    throw new ManifestError('health.timeoutMs must be a number between 500 and 120000.')
  }
  return { path: healthPath, timeoutMs: timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS }
}

/** Build a complete, valid manifest from agent-supplied intent plus an allocated port. */
export function buildManifest(input: ManifestInput, port: number): Manifest {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ManifestError(`Invalid port ${String(port)}.`)
  }
  return {
    name: validateName(input.name),
    kind: validateKind(input.kind),
    entry: validateEntry(input.entry),
    port,
    env: validateEnv(input.env),
    enabled: true,
    health: validateHealth(input.health),
  }
}

export function serialiseManifest(m: Manifest): string {
  return JSON.stringify(m, null, 2) + '\n'
}

/** Parse a manifest from disk. Hand-edited garbage must never crash the server. */
export function parseManifest(json: string): Manifest {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    throw new ManifestError('Manifest is not valid JSON.')
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new ManifestError('Manifest must be an object.')
  }
  const o = raw as Record<string, unknown>
  if (!Number.isInteger(o.port)) throw new ManifestError('Manifest has no valid port.')
  const built = buildManifest(o as ManifestInput, o.port as number)
  return { ...built, enabled: o.enabled !== false }
}

export function serviceDir(root: string, name: string): string {
  return path.join(root, 'services', validateName(name))
}

export function manifestPath(root: string, name: string): string {
  return path.join(serviceDir(root, name), 'service.json')
}

export async function saveManifest(root: string, m: Manifest): Promise<void> {
  await fs.mkdir(serviceDir(root, m.name), { recursive: true })
  await fs.writeFile(manifestPath(root, m.name), serialiseManifest(m), 'utf-8')
}

/**
 * Every readable manifest under services/. An invalid one is skipped with a
 * warning — a hand-edited file must not take the dev server down. A directory
 * with no manifest at all is skipped silently: a rollback can leave an empty
 * directory behind (Windows keeps it while the stopped process held it as cwd),
 * and warning about that on every status poll would bury the real log lines.
 */
export async function listManifests(root: string): Promise<Manifest[]> {
  const dir = path.join(root, 'services')
  let names: string[]
  try {
    names = (await fs.readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return [] // no services/ directory yet
  }
  const out: Manifest[] = []
  for (const name of names) {
    let raw: string
    try {
      raw = await fs.readFile(path.join(dir, name, 'service.json'), 'utf-8')
    } catch {
      continue // not a service directory
    }
    try {
      out.push(parseManifest(raw))
    } catch (err) {
      console.warn(`[agent] ignoring services/${name}: ${String(err)}`)
    }
  }
  return out
}
