# Agent-managed services — M1 (processes end to end) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The internal coding agent can create, start, stop, inspect and remove long-running Node/TypeScript services that run as separate processes beside the Vite dev server, wire the React app to them through a `/svc/<name>` proxy, and have a broken service caught by the existing health gate.

**Architecture:** Manifests in `services/<name>/service.json` are the declared state and are written **only** by the dev server (the agent writes service source code, never the manifest). A supervisor in the Vite plugin reconciles reality to the declared state on boot, after every turn and after a rollback. Services run under Node's permission model, jailed to their own directory. Docker containers are **M2** and are deliberately absent here — but `ServiceKind` and the `Runnable` interface exist so M2 slots in without rework.

**Tech Stack:** Node 22.14 (`--permission`, `--experimental-strip-types`), Vite 8 plugin middleware, React 19, `node:test` + `node:assert/strict` for unit tests. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-09-16-agent-services-docker-design.md`

---

## Verified before planning (do not re-derive)

Measured on this machine on 2026-09-16. The spike the spec demanded has already been run — these are facts, not assumptions:

- `node --permission --allow-fs-read=<dir> --allow-fs-write=<dir> --allow-fs-read=<root>/node_modules --experimental-strip-types index.ts` **works**. Type stripping and the permission model compose.
- Under those flags, from inside the service directory: `import ts from "typescript"` **resolves** (typescript 6.0.3), `http.createServer` + `fetch` **work**, writing inside the service dir **works**, reading `../../package.json` and `../../.env` is **blocked** (`ERR_ACCESS_DENIED`), and `child_process.execSync` is **blocked** (`ERR_ACCESS_DENIED`).
- **`--allow-net` does not exist in Node 22** — the permission model does not gate the network there. Do not pass it; it is a hard startup error (`bad option: --allow-net`).
- A service directory needs its own `services/<name>/package.json` containing `{ "type": "module" }`, otherwise Node prints a `MODULE_TYPELESS_PACKAGE_JSON` warning and reparses every file. `create_service` writes it.
- `gitCommitAll` already uses `git add -A` (`server/agentPlugin.ts:109`), so manifests and deletions are covered by the existing snapshot/rollback machinery with no change.
- `checkSyntax` already handles `.ts`, so service source gets the write-time syntax gate for free.

## Design refinement discovered while planning

The spec's manifest has no way to express "the user stopped this by hand". Without it, the post-turn health gate would flag a manually stopped service as broken and the agent would restart it, fighting the user. **The manifest therefore carries `enabled: boolean`.** `control_service stop` sets `enabled: false`; `start` sets it back to `true`. Reconciliation starts only enabled services, and the health gate ignores disabled ones. This is additive to the spec and is folded in below.

## File structure

| File | Status | Responsibility |
|---|---|---|
| `server/services/manifest.ts` | create | Schema, validation, parse/serialise, on-disk I/O |
| `server/services/logBuffer.ts` | create | Bounded line buffer for process output |
| `server/services/ports.ts` | create | Port-pool allocation with real bind checks |
| `server/services/processRunnable.ts` | create | Spawn/kill Node processes, readiness polling, logs |
| `server/services/supervisor.ts` | create | Registry, lifecycle, reconciliation |
| `server/services/routes.ts` | create | `/api/services/*` HTTP layer and the `/svc/:name` proxy |
| `server/agentPlugin.ts` | modify | Wire routes, protect `service.json`, add `/api/fs/delete`, reconcile on rollback and on shutdown |
| `src/agent/tools.ts` | modify | Five new tool schemas + executors, plus `delete_file` |
| `src/agent/systemPrompt.ts` | modify | Teach the agent the services workflow |
| `src/agent/healthReport.ts` | modify | New `service` / `infra` problem kinds |
| `src/agent/serviceHealth.ts` | create | Supervisor status → `Problem[]` (pure) |
| `src/agent/verify.ts` | modify | Fourth health source, checked first |
| `src/agent/loop.ts` | modify | Run the health gate for service-only turns too |
| `src/chat/ServicesPanel.tsx` | create | The UI panel |
| `src/chat/Chat.tsx` | modify | Mount the panel |
| `src/chat/chat.css` | modify | Panel styles |
| `tests/serviceManifest.test.ts` | create | Manifest validation |
| `tests/logBuffer.test.ts` | create | Line buffering |
| `tests/servicePorts.test.ts` | create | Allocation |
| `tests/spawnArgs.test.ts` | create | Spawn argument construction |
| `tests/serviceSupervisor.test.ts` | create | Reconcile diffing |
| `tests/serviceHealth.test.ts` | create | Status → problems mapping |
| `package.json` | modify | Register the new test files |

Everything new on the server lives under `server/services/` and everything new in the agent lives in `src/agent/` or `src/chat/` — all already write-protected, so the agent cannot modify its own service machinery.

---

## Task 1: Manifest schema and validation

**Files:**
- Create: `server/services/manifest.ts`
- Test: `tests/serviceManifest.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/serviceManifest.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ManifestError,
  buildManifest,
  parseManifest,
  serialiseManifest,
} from '../server/services/manifest.ts'

test('a minimal input gets defaults filled in', () => {
  const m = buildManifest({ name: 'notes-api', kind: 'process', entry: 'index.ts' }, 4001)
  assert.equal(m.name, 'notes-api')
  assert.equal(m.port, 4001)
  assert.equal(m.enabled, true)
  assert.deepEqual(m.env, {})
  assert.equal(m.health.path, '/health')
  assert.equal(m.health.timeoutMs, 10_000)
})

test('bad names are rejected with a message the model can act on', () => {
  for (const bad of ['A-Bad', 'x', '1abc', 'has space', 'trailing-', '']) {
    assert.throws(
      () => buildManifest({ name: bad, kind: 'process', entry: 'index.ts' }, 4001),
      ManifestError,
      `expected ${JSON.stringify(bad)} to be rejected`,
    )
  }
  assert.throws(() => buildManifest({ name: 'a b', kind: 'process', entry: 'index.ts' }, 4001), {
    message: /lowercase letters/,
  })
})

test('entry must be a single file name, never a path', () => {
  assert.throws(
    () => buildManifest({ name: 'api', kind: 'process', entry: '../../evil.ts' }, 4001),
    ManifestError,
  )
  assert.throws(
    () => buildManifest({ name: 'api', kind: 'process', entry: 'src/index.ts' }, 4001),
    ManifestError,
  )
  assert.equal(
    buildManifest({ name: 'api', kind: 'process', entry: 'server.js' }, 4001).entry,
    'server.js',
  )
})

test('reserved env keys are refused so the sandbox cannot be widened', () => {
  assert.throws(
    () =>
      buildManifest(
        { name: 'api', kind: 'process', entry: 'index.ts', env: { NODE_OPTIONS: '--allow-fs-write=/' } },
        4001,
      ),
    { message: /reserved/ },
  )
  assert.throws(
    () => buildManifest({ name: 'api', kind: 'process', entry: 'index.ts', env: { PORT: '9' } }, 4001),
    { message: /reserved/ },
  )
})

test('env values must be strings and keys UPPER_SNAKE_CASE', () => {
  assert.throws(
    () => buildManifest({ name: 'api', kind: 'process', entry: 'index.ts', env: { db: 'x' } }, 4001),
    { message: /UPPER_SNAKE_CASE/ },
  )
  assert.throws(
    () => buildManifest({ name: 'api', kind: 'process', entry: 'index.ts', env: { DB: 5 } }, 4001),
    { message: /must be a string/ },
  )
})

test('a manifest survives a serialise/parse round trip', () => {
  const m = buildManifest(
    { name: 'notes-api', kind: 'process', entry: 'index.ts', env: { DATABASE_URL: 'x' }, health: { path: '/up', timeoutMs: 2000 } },
    4002,
  )
  assert.deepEqual(parseManifest(serialiseManifest(m)), m)
})

test('parse keeps enabled:false and rejects a manifest without a port', () => {
  assert.equal(parseManifest('{"name":"api","kind":"process","entry":"i.ts","port":4001,"enabled":false}').enabled, false)
  assert.throws(() => parseManifest('{"name":"api","kind":"process","entry":"i.ts"}'), { message: /port/ })
  assert.throws(() => parseManifest('not json'), { message: /valid JSON/ })
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npm test -- tests/serviceManifest.test.ts` — or directly:
`node --experimental-strip-types --test tests/serviceManifest.test.ts`
Expected: FAIL, `Cannot find module '../server/services/manifest.ts'`.

- [ ] **Step 3: Write the implementation**

```ts
// server/services/manifest.ts
// Schema, validation and on-disk I/O for service manifests. The validation half
// is pure so it can be unit-tested; the fs half is three thin helpers at the end.
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
  const { path: p, timeoutMs } = value as { path?: unknown; timeoutMs?: unknown }
  if (typeof p !== 'string' || !p.startsWith('/')) {
    throw new ManifestError(`Invalid health.path ${JSON.stringify(p)} — must start with "/".`)
  }
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || timeoutMs < 500 || timeoutMs > 120_000)) {
    throw new ManifestError('health.timeoutMs must be a number between 500 and 120000.')
  }
  return { path: p, timeoutMs: timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS }
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
  if (typeof raw !== 'object' || raw === null) throw new ManifestError('Manifest must be an object.')
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
 * Every readable manifest under services/. Unreadable or invalid ones are
 * skipped with a warning — a hand-edited file must not take the dev server down.
 */
export async function listManifests(root: string): Promise<Manifest[]> {
  const dir = path.join(root, 'services')
  let entries: string[]
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return [] // no services/ directory yet
  }
  const out: Manifest[] = []
  for (const name of entries) {
    try {
      out.push(parseManifest(await fs.readFile(path.join(dir, name, 'service.json'), 'utf-8')))
    } catch (err) {
      console.warn(`[agent] ignoring services/${name}: ${String(err)}`)
    }
  }
  return out
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --experimental-strip-types --test tests/serviceManifest.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Register the test file and commit**

Add `tests/serviceManifest.test.ts` to the `test` script in `package.json`:

```json
"test": "node --experimental-strip-types --test tests/syntaxCheck.test.ts tests/tscCheck.test.ts tests/healthReport.test.ts tests/serviceManifest.test.ts",
```

```bash
git add server/services/manifest.ts tests/serviceManifest.test.ts package.json
git commit -m "feat(services): manifest schema and validation"
```

---

## Task 2: Bounded log buffer

**Files:**
- Create: `server/services/logBuffer.ts`
- Test: `tests/logBuffer.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/logBuffer.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLogBuffer } from '../server/services/logBuffer.ts'

test('chunks that split a line mid-way are joined', () => {
  const buf = createLogBuffer(10)
  buf.push('hello ')
  buf.push('world\n')
  assert.equal(buf.tail(10), 'hello world')
})

test('tail returns the last n lines, newest last', () => {
  const buf = createLogBuffer(10)
  buf.push('a\nb\nc\n')
  assert.equal(buf.tail(2), 'b\nc')
})

test('an unterminated final line is still visible', () => {
  const buf = createLogBuffer(10)
  buf.push('done\nstill typing')
  assert.equal(buf.tail(10), 'done\nstill typing')
})

test('the buffer never grows past its cap', () => {
  const buf = createLogBuffer(3)
  buf.push('1\n2\n3\n4\n5\n')
  assert.equal(buf.tail(100), '3\n4\n5')
})

test('carriage returns from Windows output are stripped', () => {
  const buf = createLogBuffer(10)
  buf.push('line\r\n')
  assert.equal(buf.tail(10), 'line')
})

test('clear empties both completed and partial lines', () => {
  const buf = createLogBuffer(10)
  buf.push('a\npartial')
  buf.clear()
  assert.equal(buf.tail(10), '')
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --experimental-strip-types --test tests/logBuffer.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the implementation**

```ts
// server/services/logBuffer.ts
// A fixed-size line buffer for a service's stdout/stderr. Bounded on purpose:
// a chatty service must not be able to grow the dev server's memory without
// limit, and a crash report only ever needs the last few lines.

export interface LogBuffer {
  /** Append a raw chunk; partial lines are held until their newline arrives. */
  push(chunk: string): void
  /** The last `lines` lines, newest last, joined by "\n". */
  tail(lines: number): string
  clear(): void
}

export function createLogBuffer(max = 200): LogBuffer {
  const lines: string[] = []
  let partial = ''

  return {
    push(chunk) {
      const parts = (partial + chunk).split('\n')
      partial = parts.pop() ?? ''
      for (const part of parts) {
        lines.push(part.replace(/\r$/, ''))
        if (lines.length > max) lines.shift()
      }
    },
    tail(count) {
      const all = partial.length > 0 ? [...lines, partial] : lines
      return all.slice(-count).join('\n')
    },
    clear() {
      lines.length = 0
      partial = ''
    },
  }
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --experimental-strip-types --test tests/logBuffer.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Register and commit**

Append `tests/logBuffer.test.ts` to the `test` script in `package.json`.

```bash
git add server/services/logBuffer.ts tests/logBuffer.test.ts package.json
git commit -m "feat(services): bounded log buffer"
```

---

## Task 3: Port allocation

**Files:**
- Create: `server/services/ports.ts`
- Test: `tests/servicePorts.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/servicePorts.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { allocatePort, isPortFree } from '../server/services/ports.ts'

function occupy(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(port, '127.0.0.1', () => resolve(srv))
  })
}

test('a port someone else holds is not free', async () => {
  const srv = await occupy(4098)
  try {
    assert.equal(await isPortFree(4098), false)
  } finally {
    srv.close()
  }
})

test('allocation skips ports already taken by known services', async () => {
  const port = await allocatePort([4001, 4002], { from: 4001, to: 4099 })
  assert.equal(port, 4003)
})

test('allocation skips a port occupied by an unrelated process', async () => {
  const srv = await occupy(4001)
  try {
    assert.equal(await allocatePort([], { from: 4001, to: 4099 }), 4002)
  } finally {
    srv.close()
  }
})

test('an exhausted range is an explicit error, never a silent reuse', async () => {
  await assert.rejects(() => allocatePort([4001, 4002], { from: 4001, to: 4002 }), /No free port/)
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --experimental-strip-types --test tests/servicePorts.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the implementation**

```ts
// server/services/ports.ts
// Host-port allocation. Every candidate is confirmed with a real bind attempt,
// so a port held by something outside this project is skipped instead of
// colliding later at start time.

import net from 'node:net'

export interface PortRange {
  from: number
  to: number
}

export const PROCESS_PORTS: PortRange = { from: 4001, to: 4099 }

export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, '127.0.0.1')
  })
}

/** Lowest free port in `range` that is not already claimed by a manifest. */
export async function allocatePort(
  taken: Iterable<number>,
  range: PortRange = PROCESS_PORTS,
): Promise<number> {
  const claimed = new Set(taken)
  for (let port = range.from; port <= range.to; port++) {
    if (claimed.has(port)) continue
    if (await isPortFree(port)) return port
  }
  throw new Error(
    `No free port in range ${range.from}-${range.to}. Remove an unused service and try again.`,
  )
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --experimental-strip-types --test tests/servicePorts.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Register and commit**

Append `tests/servicePorts.test.ts` to the `test` script in `package.json`.

```bash
git add server/services/ports.ts tests/servicePorts.test.ts package.json
git commit -m "feat(services): port allocation with real bind checks"
```

---

## Task 4: Spawn arguments (the sandbox, as a pure function)

The flags below are exactly the ones verified in the spike. Getting them wrong silently removes the containment, so they are built by a pure function with its own test rather than inline at the spawn site.

**Files:**
- Create: `server/services/processRunnable.ts` (first half — the pure part)
- Test: `tests/spawnArgs.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/spawnArgs.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { buildManifest } from '../server/services/manifest.ts'
import { spawnArgsFor } from '../server/services/processRunnable.ts'

const ROOT = path.resolve('C:/projects/demo')
const manifest = buildManifest(
  { name: 'notes-api', kind: 'process', entry: 'index.ts', env: { DATABASE_URL: 'postgres://x' } },
  4001,
)

test('the process is jailed to its own directory plus node_modules', () => {
  const { args, cwd } = spawnArgsFor(ROOT, manifest)
  const dir = path.join(ROOT, 'services', 'notes-api')
  assert.equal(cwd, dir)
  assert.ok(args.includes('--permission'), 'permission model must be on')
  assert.ok(args.includes(`--allow-fs-read=${dir}`))
  assert.ok(args.includes(`--allow-fs-write=${dir}`))
  assert.ok(args.includes(`--allow-fs-read=${path.join(ROOT, 'node_modules')}`))
  assert.ok(args.includes('--experimental-strip-types'))
  assert.equal(args.at(-1), 'index.ts', 'the entry file must be the last argument')
})

test('--allow-net is never passed (Node 22 rejects it as a bad option)', () => {
  assert.ok(!spawnArgsFor(ROOT, manifest).args.some((a) => a.startsWith('--allow-net')))
})

test('nothing may be written outside the service directory', () => {
  const writes = spawnArgsFor(ROOT, manifest).args.filter((a) => a.startsWith('--allow-fs-write'))
  assert.deepEqual(writes, [`--allow-fs-write=${path.join(ROOT, 'services', 'notes-api')}`])
})

test('the child gets PORT and its own env, and does not inherit the parent env', () => {
  process.env.LEAKY_SECRET = 'do-not-pass-this-on'
  try {
    const { env } = spawnArgsFor(ROOT, manifest)
    assert.equal(env.PORT, '4001')
    assert.equal(env.DATABASE_URL, 'postgres://x')
    assert.equal(env.LEAKY_SECRET, undefined)
    assert.equal(env.PATH, process.env.PATH, 'PATH is needed to run node at all')
  } finally {
    delete process.env.LEAKY_SECRET
  }
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --experimental-strip-types --test tests/spawnArgs.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the implementation**

```ts
// server/services/processRunnable.ts
// Runs a service as a child Node process under the permission model.
//
// The flags in spawnArgsFor were verified on Node 22.14: with them, a service
// can import from node_modules and use the network, but reading ../../.env.example,
// writing outside its own directory and spawning child processes all fail with
// ERR_ACCESS_DENIED. Do NOT add --allow-net: it does not exist in Node 22 and
// makes the process refuse to start.

import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { serviceDir, type Manifest } from './manifest.ts'

export interface SpawnArgs {
  args: string[]
  cwd: string
  env: Record<string, string>
}

export function spawnArgsFor(root: string, m: Manifest): SpawnArgs {
  const dir = serviceDir(root, m.name)
  return {
    cwd: dir,
    args: [
      '--permission',
      `--allow-fs-read=${dir}`,
      `--allow-fs-write=${dir}`,
      `--allow-fs-read=${path.join(root, 'node_modules')}`,
      '--experimental-strip-types',
      m.entry,
    ],
    // A deliberately minimal env: PATH and SystemRoot are what Node needs to
    // run and to open sockets on Windows. Everything else the service sees is
    // what its manifest declares.
    env: {
      PATH: process.env.PATH ?? '',
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      ...m.env,
      PORT: String(m.port),
    },
  }
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --experimental-strip-types --test tests/spawnArgs.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Register and commit**

Append `tests/spawnArgs.test.ts` to the `test` script in `package.json`.

```bash
git add server/services/processRunnable.ts tests/spawnArgs.test.ts package.json
git commit -m "feat(services): sandboxed spawn arguments"
```

---

## Task 5: The process runnable — spawn, readiness, kill, logs

No unit test here: this is process and socket I/O, which the repo's existing testing approach (see the self-healing spec) leaves to manual scenarios. The pure parts were tested in Tasks 2 and 4.

**Files:**
- Modify: `server/services/processRunnable.ts` (append below `spawnArgsFor`)

- [ ] **Step 1: Append the runnable**

```ts
export type RunState = 'stopped' | 'starting' | 'ready' | 'crashed'

export interface RunInfo {
  state: RunState
  pid?: number
  startedAt?: number
  exitCode?: number | null
  /** Set when state is 'crashed': the tail that explains why. */
  lastLogs?: string
}

/** The one interface the supervisor talks to. M2 adds a container implementation. */
export interface Runnable {
  start(m: Manifest): Promise<void>
  stop(m: Manifest): Promise<void>
  status(m: Manifest): Promise<RunInfo>
  logs(m: Manifest, lines: number): Promise<string>
  /** Names this runnable currently has processes/containers for. */
  running(): Promise<string[]>
  stopAll(): Promise<void>
}

interface Entry {
  child: ChildProcess
  buffer: LogBuffer
  info: RunInfo
}

const POLL_INTERVAL_MS = 250

/** Poll the health path until it answers, the timeout expires, or the process dies. */
async function waitForReady(m: Manifest, alive: () => boolean): Promise<string | null> {
  const deadline = Date.now() + m.health.timeoutMs
  const url = `http://127.0.0.1:${m.port}${m.health.path}`
  while (Date.now() < deadline) {
    if (!alive()) return 'the process exited during startup'
    try {
      const res = await fetch(url)
      if (res.ok) return null
    } catch {
      // not listening yet — keep polling
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
  return `${url} did not answer within ${m.health.timeoutMs} ms`
}

export function createProcessRunnable(root: string): Runnable {
  const entries = new Map<string, Entry>()

  /** Kill a process tree. child.kill() leaves grandchildren alive on Windows. */
  async function killTree(entry: Entry): Promise<void> {
    const pid = entry.child.pid
    if (pid === undefined || entry.child.exitCode !== null) return
    if (process.platform === 'win32') {
      await new Promise<void>((resolve) => {
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }).on('exit', () =>
          resolve(),
        )
      })
      return
    }
    entry.child.kill('SIGTERM')
    const deadline = Date.now() + 5000
    while (entry.child.exitCode === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
    }
    if (entry.child.exitCode === null) entry.child.kill('SIGKILL')
  }

  return {
    async start(m) {
      const existing = entries.get(m.name)
      if (existing && existing.info.state !== 'crashed' && existing.info.state !== 'stopped') return
      const { args, cwd, env } = spawnArgsFor(root, m)
      const buffer = createLogBuffer()
      const child = spawn(process.execPath, args, { cwd, env, windowsHide: true })
      const entry: Entry = {
        child,
        buffer,
        info: { state: 'starting', pid: child.pid, startedAt: Date.now() },
      }
      entries.set(m.name, entry)

      child.stdout?.setEncoding('utf-8').on('data', (c: string) => buffer.push(c))
      child.stderr?.setEncoding('utf-8').on('data', (c: string) => buffer.push(c))
      child.on('exit', (code) => {
        // A clean stop sets 'stopped' before killing, so only unexpected exits
        // land here as a crash — that distinction is what the health gate reads.
        if (entry.info.state !== 'stopped') {
          entry.info = { ...entry.info, state: 'crashed', exitCode: code, lastLogs: buffer.tail(10) }
        }
      })

      const failure = await waitForReady(m, () => child.exitCode === null)
      if (failure) {
        entry.info = {
          ...entry.info,
          state: 'crashed',
          exitCode: child.exitCode,
          lastLogs: `${failure}\n${buffer.tail(10)}`,
        }
        throw new Error(`Service "${m.name}" did not become ready: ${failure}\n${buffer.tail(10)}`)
      }
      entry.info = { ...entry.info, state: 'ready' }
    },

    async stop(m) {
      const entry = entries.get(m.name)
      if (!entry) return
      entry.info = { ...entry.info, state: 'stopped' }
      await killTree(entry)
      entries.delete(m.name)
    },

    async status(m) {
      return entries.get(m.name)?.info ?? { state: 'stopped' }
    },

    async logs(m, lines) {
      return entries.get(m.name)?.buffer.tail(lines) ?? ''
    },

    async running() {
      return [...entries.entries()]
        .filter(([, e]) => e.info.state === 'starting' || e.info.state === 'ready')
        .map(([name]) => name)
    },

    async stopAll() {
      for (const entry of entries.values()) {
        entry.info = { ...entry.info, state: 'stopped' }
        await killTree(entry)
      }
      entries.clear()
    },
  }
}
```

- [ ] **Step 2: Add the missing import at the top of the file**

```ts
import { createLogBuffer, type LogBuffer } from './logBuffer.ts'
```

(`spawn` and `ChildProcess` are already imported from Task 4.)

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit -p tsconfig.node.json`
Expected: no output (success). If `server/` is not covered by that config, run `npm run build` and confirm no new errors in `server/services/`.

- [ ] **Step 4: Commit**

```bash
git add server/services/processRunnable.ts
git commit -m "feat(services): process runnable with readiness polling and tree kill"
```

---

## Task 6: Supervisor and reconciliation

**Files:**
- Create: `server/services/supervisor.ts`
- Test: `tests/serviceSupervisor.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/serviceSupervisor.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reconcilePlan } from '../server/services/supervisor.ts'

const declared = (name: string, enabled = true) => ({ name, enabled })

test('a declared service that is not running gets started', () => {
  assert.deepEqual(reconcilePlan([declared('api')], []), { toStart: ['api'], toStop: [] })
})

test('a running service that is no longer declared gets stopped', () => {
  // This is what makes rollback work: the manifest is gone, so the service dies.
  assert.deepEqual(reconcilePlan([], ['api']), { toStart: [], toStop: ['api'] })
})

test('a matching pair is left alone', () => {
  assert.deepEqual(reconcilePlan([declared('api')], ['api']), { toStart: [], toStop: [] })
})

test('a disabled service is never started, and is stopped if it runs', () => {
  assert.deepEqual(reconcilePlan([declared('api', false)], []), { toStart: [], toStop: [] })
  assert.deepEqual(reconcilePlan([declared('api', false)], ['api']), { toStart: [], toStop: ['api'] })
})

test('mixed state is handled in one pass', () => {
  assert.deepEqual(reconcilePlan([declared('a'), declared('b'), declared('c', false)], ['b', 'orphan']), {
    toStart: ['a'],
    toStop: ['orphan'],
  })
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --experimental-strip-types --test tests/serviceSupervisor.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the implementation**

```ts
// server/services/supervisor.ts
// Owns the declared state (manifests on disk) and the actual state (running
// processes), and keeps them in sync. Reconciliation is what makes a git
// rollback effective: restoring the tree removes manifests, and the next
// reconcile stops whatever is no longer declared.

import fs from 'node:fs/promises'
import { allocatePort } from './ports.ts'
import {
  buildManifest,
  listManifests,
  saveManifest,
  serviceDir,
  validateName,
  type Manifest,
  type ManifestInput,
} from './manifest.ts'
import { createProcessRunnable, type RunInfo, type Runnable } from './processRunnable.ts'

export interface ReconcilePlan {
  toStart: string[]
  toStop: string[]
}

/** Pure set arithmetic — the part worth unit-testing. */
export function reconcilePlan(
  declared: { name: string; enabled: boolean }[],
  running: string[],
): ReconcilePlan {
  const wanted = declared.filter((d) => d.enabled).map((d) => d.name)
  const runningSet = new Set(running)
  return {
    toStart: wanted.filter((name) => !runningSet.has(name)),
    toStop: running.filter((name) => !wanted.includes(name)),
  }
}

export interface ServiceStatus extends RunInfo {
  name: string
  kind: Manifest['kind']
  port: number
  enabled: boolean
  url: string
}

export interface Supervisor {
  create(input: ManifestInput): Promise<Manifest>
  control(name: string, action: 'start' | 'stop' | 'restart'): Promise<ServiceStatus>
  remove(name: string): Promise<void>
  status(): Promise<ServiceStatus[]>
  logs(name: string, lines: number): Promise<string>
  reconcile(): Promise<ReconcilePlan>
  shutdown(): Promise<void>
  /** Manifest for `name`, or undefined — used by the /svc proxy. */
  find(name: string): Promise<Manifest | undefined>
}

export function createSupervisor(root: string): Supervisor {
  const runnable: Runnable = createProcessRunnable(root)

  async function manifestOf(name: string): Promise<Manifest> {
    const found = (await listManifests(root)).find((m) => m.name === validateName(name))
    if (!found) throw new Error(`Unknown service "${name}".`)
    return found
  }

  async function statusOf(m: Manifest): Promise<ServiceStatus> {
    return {
      ...(await runnable.status(m)),
      name: m.name,
      kind: m.kind,
      port: m.port,
      enabled: m.enabled,
      url: `/svc/${m.name}`,
    }
  }

  return {
    async create(input) {
      const name = validateName(input.name)
      const existing = await listManifests(root)
      if (existing.some((m) => m.name === name)) {
        throw new Error(
          `A service named "${name}" already exists. Existing services: ${existing.map((m) => m.name).join(', ')}.`,
        )
      }
      const port = await allocatePort(existing.map((m) => m.port))
      const manifest = buildManifest(input, port)
      await saveManifest(root, manifest)
      // Without this, Node warns about a typeless package and reparses every
      // file on every start (verified during the spike).
      await fs.writeFile(
        `${serviceDir(root, name)}/package.json`,
        JSON.stringify({ type: 'module' }, null, 2) + '\n',
        'utf-8',
      )
      return manifest
    },

    async control(name, action) {
      const m = await manifestOf(name)
      if (action === 'stop') {
        await runnable.stop(m)
        await saveManifest(root, { ...m, enabled: false })
        return statusOf({ ...m, enabled: false })
      }
      if (action === 'restart') await runnable.stop(m)
      const enabled = { ...m, enabled: true }
      await saveManifest(root, enabled)
      await runnable.start(enabled)
      return statusOf(enabled)
    },

    async remove(name) {
      const m = await manifestOf(name)
      await runnable.stop(m)
      await fs.rm(serviceDir(root, m.name), { recursive: true, force: true })
    },

    async status() {
      const manifests = await listManifests(root)
      return Promise.all(manifests.map(statusOf))
    },

    async logs(name, lines) {
      return runnable.logs(await manifestOf(name), lines)
    },

    async reconcile() {
      const manifests = await listManifests(root)
      const plan = reconcilePlan(manifests, await runnable.running())
      for (const name of plan.toStop) {
        const m = manifests.find((x) => x.name === name)
        // An orphan whose manifest is gone still needs killing: synthesise the
        // minimum the runnable needs to find it.
        await runnable.stop(m ?? ({ name, port: 0 } as Manifest))
      }
      for (const name of plan.toStart) {
        const m = manifests.find((x) => x.name === name)
        if (!m) continue
        try {
          await runnable.start(m)
        } catch (err) {
          console.warn(`[agent] service ${name} failed to start: ${String(err)}`)
        }
      }
      return plan
    },

    async shutdown() {
      await runnable.stopAll()
    },

    async find(name) {
      return (await listManifests(root)).find((m) => m.name === name)
    },
  }
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --experimental-strip-types --test tests/serviceSupervisor.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Register and commit**

Append `tests/serviceSupervisor.test.ts` to the `test` script in `package.json`.

```bash
git add server/services/supervisor.ts tests/serviceSupervisor.test.ts package.json
git commit -m "feat(services): supervisor with declarative reconciliation"
```

---

## Task 7: HTTP routes and the /svc proxy

**Files:**
- Create: `server/services/routes.ts`

- [ ] **Step 1: Write the routes module**

```ts
// server/services/routes.ts
// The HTTP surface of the supervisor: /api/services/* for the agent and the
// panel, and /svc/<name>/* as a same-origin proxy so components never hardcode
// a port and never need CORS.

import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Supervisor } from './supervisor.ts'

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

/** Forward a browser request to the service's own HTTP server. */
async function proxy(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  supervisor: Supervisor,
): Promise<void> {
  const [, , name, ...rest] = url.split('/') // "" / "svc" / name / path…
  const manifest = await supervisor.find(name ?? '')
  if (!manifest) return sendJson(res, 404, { error: `Unknown service: ${name}` })
  const status = (await supervisor.status()).find((s) => s.name === name)
  if (status?.state !== 'ready') {
    return sendJson(res, 503, {
      error: `Service "${name}" is ${status?.state ?? 'stopped'} — start it before calling it.`,
    })
  }

  const search = (req.url ?? '').includes('?') ? `?${(req.url ?? '').split('?')[1]}` : ''
  const upstream = http.request(
    {
      host: '127.0.0.1',
      port: manifest.port,
      method: req.method,
      path: `/${rest.join('/')}${search}`,
      headers: { ...req.headers, host: `127.0.0.1:${manifest.port}` },
    },
    (up) => {
      res.statusCode = up.statusCode ?? 502
      for (const [key, value] of Object.entries(up.headers)) {
        if (value !== undefined) res.setHeader(key, value)
      }
      up.pipe(res)
    },
  )
  upstream.on('error', (err) => {
    sendJson(res, 502, { error: `Service "${name}" is not reachable: ${err.message}` })
  })
  req.pipe(upstream)
}

/**
 * Handle a service request. Returns false when the URL is none of ours, so the
 * caller can fall through to the next middleware.
 */
export async function handleServiceRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  supervisor: Supervisor,
  log: (msg: string) => void,
): Promise<boolean> {
  if (url.startsWith('/svc/')) {
    await proxy(req, res, url, supervisor)
    return true
  }
  if (!url.startsWith('/api/services')) return false

  try {
    if (url === '/api/services' && req.method === 'GET') {
      sendJson(res, 200, { services: await supervisor.status() })
      return true
    }
    if (url === '/api/services/create' && req.method === 'POST') {
      const manifest = await supervisor.create(JSON.parse(await readBody(req)))
      log(`service create ${manifest.name} → port ${manifest.port}`)
      sendJson(res, 200, { manifest, url: `/svc/${manifest.name}` })
      return true
    }
    if (url === '/api/services/control' && req.method === 'POST') {
      const { name, action } = JSON.parse(await readBody(req))
      if (action !== 'start' && action !== 'stop' && action !== 'restart') {
        sendJson(res, 400, { error: 'action must be start, stop or restart' })
        return true
      }
      const status = await supervisor.control(String(name), action)
      log(`service ${action} ${String(name)} → ${status.state}`)
      sendJson(res, 200, { status })
      return true
    }
    if (url === '/api/services/remove' && req.method === 'POST') {
      const { name } = JSON.parse(await readBody(req))
      await supervisor.remove(String(name))
      log(`service remove ${String(name)}`)
      sendJson(res, 200, { ok: true })
      return true
    }
    if (url === '/api/services/logs' && req.method === 'POST') {
      const { name, lines } = JSON.parse(await readBody(req))
      const count = typeof lines === 'number' && lines > 0 && lines <= 200 ? lines : 50
      sendJson(res, 200, { logs: await supervisor.logs(String(name), count) })
      return true
    }
  } catch (err) {
    // Validation failures are the normal path for a model that guessed wrong:
    // report them as 400 with the message, so it can correct itself.
    log(`service request failed: ${String(err)}`)
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
    return true
  }

  sendJson(res, 404, { error: `Unknown service route: ${req.method} ${url}` })
  return true
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit -p tsconfig.node.json`
Expected: no errors in `server/services/`.

- [ ] **Step 3: Commit**

```bash
git add server/services/routes.ts
git commit -m "feat(services): HTTP routes and same-origin /svc proxy"
```

---

## Task 8: Wire the supervisor into the dev server

**Files:**
- Modify: `server/agentPlugin.ts`

- [ ] **Step 1: Add the imports**

At the top of `server/agentPlugin.ts`, beside the existing `./syntaxCheck.ts` import:

```ts
import { handleServiceRoutes } from './services/routes.ts'
import { createSupervisor, type Supervisor } from './services/supervisor.ts'
```

- [ ] **Step 2: Protect manifests from write_file**

Replace the `isWriteProtected` function (`server/agentPlugin.ts:39-43`) with:

```ts
// services/<name>/service.json is server-owned: it may only be created through
// /api/services/create, which validates it. Source files in the same directory
// stay writable.
const WRITE_PROTECTED_PATTERNS = [/^services\/[^/]+\/service\.json$/, /^services\/[^/]+\/package\.json$/]

function isWriteProtected(root: string, abs: string): boolean {
  const rel = path.relative(root, abs).split(path.sep).join('/')
  if (WRITE_PROTECTED_FILES.includes(rel)) return true
  if (WRITE_PROTECTED_PATTERNS.some((re) => re.test(rel))) return true
  return WRITE_PROTECTED_DIRS.some((dir) => rel === dir || rel.startsWith(dir + '/'))
}
```

- [ ] **Step 3: Create the supervisor and reconcile on boot**

In `agentPlugin()`, beside the existing `let lastSnapshot…` declarations:

```ts
  let supervisor: Supervisor | null = null
```

Inside `configureServer(server)`, before `server.middlewares.use(…)`:

```ts
      supervisor = createSupervisor(root)
      // Bring declared services back after a dev-server restart. Failures are
      // logged, never fatal — a broken service must not stop the dev server.
      void supervisor.reconcile().then(
        (plan) => plan.toStart.length > 0 && logLine(`reconcile → started ${plan.toStart.join(', ')}`),
        (err) => logLine(`reconcile failed: ${String(err)}`),
      )
      // Processes are children of this server; never leave them orphaned.
      server.httpServer?.once('close', () => void supervisor?.shutdown())
```

- [ ] **Step 4: Route service requests**

This goes in the **synchronous middleware body** (beside the `/recovery` branch at `server/agentPlugin.ts:158-163`), not inside `handle()` — `/svc/` is not under `/api/`, so it must be caught before the `next()` bail-out. Replace the line `if (!url.startsWith('/api/')) return next()` with:

```ts
        if (supervisor && (url.startsWith('/svc/') || url.startsWith('/api/services'))) {
          void handleServiceRoutes(req, res, url, supervisor, logLine)
          return
        }

        if (!url.startsWith('/api/')) return next()
```

Note this sits in the synchronous middleware body (beside the `/recovery` branch), not inside `handle()`, because `/svc/` is not under `/api/`.

- [ ] **Step 5: Add the delete endpoint**

Inside `handle()`, after the `/api/fs/write` branch:

```ts
          if (url === '/api/fs/delete' && req.method === 'POST') {
            const { path: relPath, turnId } = JSON.parse(await readBody(req))
            const abs = safeResolve(root, relPath)
            if (!abs) {
              logLine(`delete ${relPath} → DENIED (outside sandbox)`)
              return sendJson(res, 403, { error: `Path not allowed: ${relPath}` })
            }
            if (isWriteProtected(root, abs)) {
              logLine(`delete ${relPath} → DENIED (agent runtime is protected)`)
              return sendJson(res, 403, { error: `Path is read-only: ${relPath}` })
            }
            let snapshot: string | null = null
            if (typeof turnId === 'string' && turnId !== lastSnapshotTurn) {
              lastSnapshotTurn = turnId
              snapshot = await gitCommitAll(root, SNAPSHOT_MESSAGE)
              const anchor = snapshot ?? (await gitHead(root))
              lastSnapshot = anchor ? { turnId, hash: anchor } : null
            }
            try {
              await fs.rm(abs, { recursive: false, force: false })
            } catch {
              logLine(`delete ${relPath} → not found`)
              return sendJson(res, 404, { error: `File not found: ${relPath}` })
            }
            logLine(`delete ${relPath}${snapshot ? ` [snapshot ${snapshot}]` : ''}`)
            return sendJson(res, 200, { ok: true, snapshot })
          }
```

- [ ] **Step 6: Reconcile after a rollback**

In the `/api/git/rollback` branch, after the `restored` commit is created and before `sendJson`:

```ts
              // The rollback removed the failed turn's manifests; reconcile now
              // stops exactly the services that turn started.
              const plan = await supervisor?.reconcile()
              if (plan && (plan.toStop.length > 0 || plan.toStart.length > 0)) {
                logLine(`rollback reconcile → stopped ${plan.toStop.join(', ') || 'none'}`)
              }
```

- [ ] **Step 7: Verify manually**

1. `npm run dev`
2. `curl http://localhost:5173/api/services` → `{"services":[]}`
3. `curl -X POST http://localhost:5173/api/services/create -H "Content-Type: application/json" -d "{\"name\":\"Bad Name\",\"kind\":\"process\",\"entry\":\"index.ts\"}"` → HTTP 400 with the name-rule message.

- [ ] **Step 8: Commit**

```bash
git add server/agentPlugin.ts
git commit -m "feat(services): wire supervisor, /svc proxy and delete_file into the dev server"
```

---

## Task 9: Agent tools

**Files:**
- Modify: `src/agent/tools.ts`

- [ ] **Step 1: Add the tool schemas**

Append these to the `toolSchemas` array, after the existing `write_file` entry:

```ts
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description:
        'Delete a file from the project. The agent runtime is protected and cannot be deleted. Use remove_service to delete a whole service.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Project-relative path' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_service',
      description:
        'Declare a new backend service that runs as its own Node process next to the dev server. The server assigns the port and returns the URL the browser must use. Write the service source with write_file afterwards, then start it with control_service.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '3-32 chars, lowercase letters, digits and dashes, e.g. "notes-api"',
          },
          kind: { type: 'string', enum: ['process'], description: 'Only "process" in this version' },
          entry: { type: 'string', description: 'Entry file name inside the service directory, e.g. "index.ts"' },
          env: {
            type: 'object',
            description: 'Optional UPPER_SNAKE_CASE environment variables. PORT is set for you.',
            additionalProperties: { type: 'string' },
          },
          health: {
            type: 'object',
            description: 'Optional readiness probe; defaults to GET /health with a 10s timeout.',
            properties: { path: { type: 'string' }, timeoutMs: { type: 'number' } },
          },
        },
        required: ['name', 'kind', 'entry'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'control_service',
      description:
        'Start, stop or restart a declared service. Starting waits until the health path answers, so a successful result means the service is really up.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          action: { type: 'string', enum: ['start', 'stop', 'restart'] },
        },
        required: ['name', 'action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_service',
      description: 'Stop a service and delete its manifest and directory.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'service_status',
      description: 'List every declared service with its state, port and browser URL.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'service_logs',
      description: "Read the tail of a service's stdout/stderr — the first thing to check when it crashed.",
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          lines: { type: 'number', description: 'How many lines (default 50, max 200)' },
        },
        required: ['name'],
      },
    },
  },
```

- [ ] **Step 2: Add the executors**

Add these cases to the `switch` in `executeTool`, before `default:`:

```ts
    case 'delete_file': {
      const exec = await api('/api/fs/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: args.path, turnId }),
      })
      if (exec.isError) return exec
      return { result: 'File deleted.', isError: false }
    }
    case 'create_service': {
      const exec = await api('/api/services/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      })
      if (exec.isError) return exec
      const body = JSON.parse(exec.result) as { manifest: { name: string; port: number; entry: string }; url: string }
      return {
        result:
          `Service "${body.manifest.name}" declared on port ${body.manifest.port}. ` +
          `Write its code to services/${body.manifest.name}/${body.manifest.entry} (it must listen on ` +
          `process.env.PORT), then call control_service to start it. The browser reaches it at ${body.url}.`,
        isError: false,
      }
    }
    case 'control_service': {
      const exec = await api('/api/services/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: args.name, action: args.action }),
      })
      if (exec.isError) return exec
      const { status } = JSON.parse(exec.result) as { status: { state: string; port: number } }
      return { result: `Service "${String(args.name)}" is now ${status.state} (port ${status.port}).`, isError: false }
    }
    case 'remove_service': {
      const exec = await api('/api/services/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: args.name }),
      })
      if (exec.isError) return exec
      return { result: `Service "${String(args.name)}" removed.`, isError: false }
    }
    case 'service_status': {
      const res = await fetch('/api/services')
      const body = await res.json()
      if (!res.ok) return { result: String(body.error), isError: true }
      const services = body.services as { name: string; state: string; port: number; enabled: boolean; url: string }[]
      if (services.length === 0) return { result: 'No services declared.', isError: false }
      return {
        result: services
          .map((s) => `${s.name}: ${s.state}${s.enabled ? '' : ' (disabled)'} · port ${s.port} · ${s.url}`)
          .join('\n'),
        isError: false,
      }
    }
    case 'service_logs': {
      const exec = await api('/api/services/logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: args.name, lines: args.lines }),
      })
      if (exec.isError) return exec
      const { logs } = JSON.parse(exec.result) as { logs: string }
      return { result: logs.length > 0 ? logs : '(no output)', isError: false }
    }
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit -p tsconfig.app.json`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/agent/tools.ts
git commit -m "feat(services): agent tools for service lifecycle and delete_file"
```

---

## Task 10: Teach the agent the workflow

**Files:**
- Modify: `src/agent/systemPrompt.ts`

- [ ] **Step 1: Extend the project layout section**

Add after the `src/components/` line:

```
- services/<name>/ — backend services you create. Each runs as its own Node process next to the dev server. You write the source files here; service.json and package.json are written by the server and are read-only for you.
```

- [ ] **Step 2: Add the services rules**

Add after the existing rule 9:

```
10. Backend services: call create_service first (the server assigns the port and tells you the browser URL), then write_file the entry file, then control_service to start it. The service MUST listen on Number(process.env.PORT) and 127.0.0.1, and must answer its health path (default GET /health) with status 200 — starting waits for that.
11. A service runs under Node's permission model: it may read and write only its own services/<name>/ directory, may use the network, and may import installed packages. It CANNOT read project files, .env, or spawn processes — do not try.
12. The browser must call a service through its proxy URL (e.g. fetch('/svc/notes-api/items')), never through http://localhost:PORT — the port can change and direct calls break with CORS.
13. If a service crashes, read service_logs before changing code. Do not restart it in a loop hoping it fixes itself.
14. You cannot install npm packages in this version, so services use Node built-ins only (node:http, fetch). Data that must survive a restart belongs in a file inside the service directory.
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit -p tsconfig.app.json`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/agent/systemPrompt.ts
git commit -m "feat(services): teach the agent the service workflow"
```

---

## Task 11: Health gate — service problems

**Files:**
- Modify: `src/agent/healthReport.ts`
- Create: `src/agent/serviceHealth.ts`
- Modify: `tests/healthReport.test.ts`
- Test: `tests/serviceHealth.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/serviceHealth.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { problemsFromServices, type ServiceStatus } from '../src/agent/serviceHealth.ts'

const base: ServiceStatus = { name: 'api', kind: 'process', state: 'ready', port: 4001, enabled: true }

test('a ready service is not a problem', () => {
  assert.deepEqual(problemsFromServices([base]), [])
})

test('a crashed service is reported with its exit code and logs', () => {
  const problems = problemsFromServices([
    { ...base, state: 'crashed', exitCode: 1, lastLogs: 'TypeError: x is not a function' },
  ])
  assert.equal(problems.length, 1)
  assert.equal(problems[0].kind, 'service')
  assert.equal(problems[0].file, 'services/api')
  assert.match(problems[0].message, /exit code 1/)
  assert.match(problems[0].message, /TypeError/)
})

test('an enabled service that is not running is a problem', () => {
  const problems = problemsFromServices([{ ...base, state: 'stopped' }])
  assert.equal(problems.length, 1)
  assert.match(problems[0].message, /not running/)
})

test('a service still starting never became ready', () => {
  assert.match(problemsFromServices([{ ...base, state: 'starting' }])[0].message, /did not become ready/)
})

test('a service the user disabled is left alone', () => {
  assert.deepEqual(problemsFromServices([{ ...base, state: 'stopped', enabled: false }]), [])
})
```

Add to `tests/healthReport.test.ts`:

```ts
test('a crashed service breaks the app, infrastructure failures do not', () => {
  assert.equal(isAppBroken([{ kind: 'service', message: 'crashed' }]), true)
  assert.equal(isAppBroken([{ kind: 'infra', message: 'docker daemon unreachable' }]), false)
})

test('the report labels service problems', () => {
  const report = buildReport([{ kind: 'service', file: 'services/api', message: 'exit code 1' }], 1, 3)
  assert.match(report, /SERVICE FAILED/)
})
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `node --experimental-strip-types --test tests/serviceHealth.test.ts tests/healthReport.test.ts`
Expected: FAIL — module not found, and `isAppBroken` treating `infra` as broken.

- [ ] **Step 3: Extend the problem kinds**

In `src/agent/healthReport.ts`:

```ts
export type ProblemKind = 'probe' | 'runtime' | 'hmr' | 'type' | 'service' | 'infra'
```

```ts
/**
 * Probe, runtime, HMR and service failures mean the running app is broken and
 * may trigger a rollback. Type errors only break `npm run build`; infra
 * failures (Docker unreachable, image pull) are environment problems, not bad
 * code — neither may ever discard the agent's work.
 */
export function isAppBroken(problems: Problem[]): boolean {
  return problems.some((p) => p.kind !== 'type' && p.kind !== 'infra')
}
```

```ts
const LABEL: Record<ProblemKind, string> = {
  probe: 'MODULE FAILED TO LOAD',
  runtime: 'RUNTIME ERROR',
  hmr: 'VITE ERROR',
  type: 'TYPE ERROR',
  service: 'SERVICE FAILED',
  infra: 'INFRASTRUCTURE PROBLEM',
}
```

- [ ] **Step 4: Write the mapping module**

```ts
// src/agent/serviceHealth.ts
// Turns supervisor status into health-check problems. Pure — no fetch in here,
// which is what makes the classification rules unit-testable.
//
// ServiceStatus deliberately mirrors the shape returned by /api/services
// (server/services/supervisor.ts) rather than importing it: browser and server
// code are separate tsconfig projects. Keep the two in sync when either moves.

import type { Problem } from './healthReport.ts'

export interface ServiceStatus {
  name: string
  kind: 'process' | 'container'
  state: 'stopped' | 'starting' | 'ready' | 'crashed'
  port: number
  enabled: boolean
  exitCode?: number | null
  lastLogs?: string
}

export function problemsFromServices(services: ServiceStatus[]): Problem[] {
  const problems: Problem[] = []
  for (const s of services) {
    // Disabled means the user stopped it by hand; restarting it would fight them.
    if (!s.enabled || s.state === 'ready') continue
    // A container that will not come up is an environment problem, not bad code.
    const kind = s.kind === 'container' ? 'infra' : 'service'
    const detail = s.lastLogs ? `\n${s.lastLogs}` : ''
    if (s.state === 'crashed') {
      problems.push({
        kind,
        file: `services/${s.name}`,
        message: `Service "${s.name}" crashed with exit code ${s.exitCode ?? 'unknown'}.${detail}`,
      })
    } else if (s.state === 'starting') {
      problems.push({
        kind,
        file: `services/${s.name}`,
        message: `Service "${s.name}" did not become ready within its health timeout.${detail}`,
      })
    } else {
      problems.push({
        kind,
        file: `services/${s.name}`,
        message: `Service "${s.name}" is declared and enabled but not running.`,
      })
    }
  }
  return problems
}
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `node --experimental-strip-types --test tests/serviceHealth.test.ts tests/healthReport.test.ts`
Expected: PASS.

- [ ] **Step 6: Register and commit**

Append `tests/serviceHealth.test.ts` to the `test` script in `package.json`.

```bash
git add src/agent/healthReport.ts src/agent/serviceHealth.ts tests/serviceHealth.test.ts tests/healthReport.test.ts package.json
git commit -m "feat(services): service and infra problem kinds in the health gate"
```

---

## Task 12: Run the health gate for service turns

**Files:**
- Modify: `src/agent/verify.ts`
- Modify: `src/agent/loop.ts`

- [ ] **Step 1: Add the fourth source to verifyApp**

In `src/agent/verify.ts`, add the import:

```ts
import { problemsFromServices, type ServiceStatus } from './serviceHealth.ts'
```

and insert this block at the start of `verifyApp`, **before** the module probe, with a comment explaining the ordering:

```ts
  // 0. Cheapest of all: an in-memory read of supervisor state.
  try {
    const res = await fetch('/api/services')
    const body = (await res.json()) as { services?: ServiceStatus[] }
    problems.push(...problemsFromServices(body.services ?? []))
  } catch (err) {
    console.warn('[health] service status unreachable:', err)
  }
```

Note: move the `const problems: Problem[] = []` declaration above this block.

- [ ] **Step 2: Make service-only turns run the gate**

In `src/agent/loop.ts`, add beside `const writtenPaths: string[] = []`:

```ts
  // A turn that only started or changed a service writes no files, but still
  // has to pass the health gate.
  let touchedServices = false
```

Inside the tool-call loop, after the `write_file` bookkeeping:

```ts
        if (tc.function.name.endsWith('_service') && !isError) touchedServices = true
```

And change the skip condition:

```ts
    // A turn that changed nothing needs no health check.
    if (writtenPaths.length === 0 && !touchedServices) {
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit -p tsconfig.app.json`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/agent/verify.ts src/agent/loop.ts
git commit -m "feat(services): check service health at the end of every turn"
```

---

## Task 13: The services panel

**Files:**
- Create: `src/chat/ServicesPanel.tsx`
- Modify: `src/chat/Chat.tsx`
- Modify: `src/chat/chat.css`

- [ ] **Step 1: Write the component**

```tsx
// src/chat/ServicesPanel.tsx
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { getSnapshot, subscribe } from './store.ts'
import type { ServiceStatus } from '../agent/serviceHealth.ts'

const POLL_MS = 3000

export function ServicesPanel() {
  const { busy } = useSyncExternalStore(subscribe, getSnapshot)
  const [services, setServices] = useState<ServiceStatus[]>([])
  const [open, setOpen] = useState(false)
  const [logs, setLogs] = useState<{ name: string; text: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/services')
      const body = await res.json()
      if (!res.ok) throw new Error(String(body.error ?? `HTTP ${res.status}`))
      setServices(body.services as ServiceStatus[])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  // Refresh after every turn, and keep polling only while expanded.
  useEffect(() => {
    if (!busy) void refresh()
  }, [busy, refresh])

  useEffect(() => {
    if (!open) return
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [open, refresh])

  const control = useCallback(
    async (name: string, action: 'start' | 'stop' | 'restart') => {
      try {
        const res = await fetch('/api/services/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, action }),
        })
        const body = await res.json()
        if (!res.ok) throw new Error(String(body.error ?? `HTTP ${res.status}`))
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
      void refresh()
    },
    [refresh],
  )

  const showLogs = useCallback(async (name: string) => {
    const res = await fetch('/api/services/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, lines: 100 }),
    })
    const body = await res.json()
    setLogs({ name, text: res.ok ? String(body.logs || '(no output)') : String(body.error) })
  }, [])

  const unhealthy = services.filter((s) => s.enabled && s.state !== 'ready').length
  const running = services.filter((s) => s.state === 'ready').length

  if (services.length === 0 && !error) return null

  return (
    <section className={`services-panel${open ? ' open' : ''}`}>
      <button className="services-summary" onClick={() => setOpen((v) => !v)}>
        <span>{open ? '▾' : '▸'} Services</span>
        <span className="services-counts">
          {running} running{unhealthy > 0 ? ` · ${unhealthy} unhealthy` : ''}
        </span>
      </button>
      {open && (
        <div className="services-list">
          {error && <div className="services-error">{error}</div>}
          {services.map((s) => (
            <div key={s.name} className="service-row">
              <span className={`service-dot ${s.state}`} title={s.state} />
              <span className="service-name">{s.name}</span>
              <code className="service-port">:{s.port}</code>
              {!s.enabled && <span className="service-badge">disabled</span>}
              <span className="service-actions">
                <button title="Start" onClick={() => void control(s.name, 'start')}>▶</button>
                <button title="Stop" onClick={() => void control(s.name, 'stop')}>■</button>
                <button title="Restart" onClick={() => void control(s.name, 'restart')}>⟳</button>
                <button title="Logs" onClick={() => void showLogs(s.name)}>≡</button>
              </span>
            </div>
          ))}
          {logs && (
            <div className="service-logs">
              <div className="service-logs-header">
                <span>{logs.name}</span>
                <button onClick={() => setLogs(null)}>✕</button>
              </div>
              <pre>{logs.text}</pre>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
```

- [ ] **Step 2: Mount it in the chat**

In `src/chat/Chat.tsx`, add the import and render it between `MessageList` and `MessageInput`:

```tsx
import { ServicesPanel } from './ServicesPanel.tsx'
```

```tsx
        <MessageList items={transcript} busy={busy} />
        <ServicesPanel />
        <MessageInput onSend={send} disabled={busy} />
```

It sits inside the chat subtree on purpose: `AppErrorBoundary` keeps the chat mounted when `App.tsx` crashes, so the panel stays usable exactly when it is most needed.

- [ ] **Step 3: Add the styles**

Append to `src/chat/chat.css`:

```css
.services-panel {
  border-top: 1px solid #333;
  background: #17171c;
  font-size: 0.85rem;
  flex-shrink: 0;
}

.services-summary {
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.5rem 0.9rem;
  background: none;
  border: none;
  color: #ddd;
  cursor: pointer;
  font-size: 0.85rem;
}

.services-counts {
  color: #888;
}

.services-list {
  max-height: 40vh;
  overflow-y: auto;
  padding: 0.3rem 0.6rem 0.6rem;
}

.service-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.3rem 0.3rem;
  border-top: 1px solid #262630;
}

.service-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #666;
  flex-shrink: 0;
}

.service-dot.ready {
  background: #3fb950;
}

.service-dot.starting {
  background: #d29922;
}

.service-dot.crashed {
  background: #f85149;
}

.service-name {
  color: #ddd;
  flex: 1;
}

.service-port {
  color: #888;
}

.service-badge {
  border: 1px solid #3a3a44;
  border-radius: 6px;
  padding: 0 0.35rem;
  color: #888;
  font-size: 0.75rem;
}

.service-actions button {
  background: none;
  border: 1px solid #3a3a44;
  border-radius: 6px;
  color: #ccc;
  cursor: pointer;
  padding: 0.1rem 0.4rem;
  margin-left: 0.25rem;
}

.service-actions button:hover {
  border-color: #666;
}

.services-error {
  color: #f85149;
  padding: 0.4rem 0.3rem;
}

.service-logs {
  margin-top: 0.5rem;
  border: 1px solid #333;
  border-radius: 6px;
  background: #0f0f13;
}

.service-logs-header {
  display: flex;
  justify-content: space-between;
  padding: 0.3rem 0.5rem;
  border-bottom: 1px solid #333;
  color: #aaa;
}

.service-logs-header button {
  background: none;
  border: none;
  color: #aaa;
  cursor: pointer;
}

.service-logs pre {
  margin: 0;
  padding: 0.5rem;
  max-height: 30vh;
  overflow: auto;
  font-size: 0.75rem;
  color: #ccc;
  white-space: pre-wrap;
}
```

- [ ] **Step 4: Verify it compiles**

Run: `npx tsc --noEmit -p tsconfig.app.json`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/chat/ServicesPanel.tsx src/chat/Chat.tsx src/chat/chat.css
git commit -m "feat(services): services panel with state, controls and logs"
```

---

## Task 14: End-to-end acceptance

No code — this is the proof that M1 works. Run every scenario and fix what fails before declaring the milestone done.

- [ ] **Step 1: Full unit suite**

First confirm the `test` script in `package.json` lists all six new files —
`serviceManifest`, `logBuffer`, `servicePorts`, `spawnArgs`, `serviceSupervisor`,
`serviceHealth` — since each was appended by a different task and one is easy to miss.

Run: `npm test`
Expected: all nine test files pass.

- [ ] **Step 2: Type check and lint**

Run: `npx tsc --noEmit -p tsconfig.app.json` and `npm run lint`
Expected: both clean.

- [ ] **Step 3: Happy path through the chat**

Start `npm run dev`, then ask the agent:

> Create a service "echo-api" with a GET /items endpoint returning three demo items, and a page that lists them.

Expected: `create_service` → `write_file` → `control_service start` → component written; the page shows the items; the panel shows `echo-api` with a green dot; `curl http://localhost:5173/svc/echo-api/items` returns the JSON.

- [ ] **Step 4: Crash repair inside the turn**

Ask:

> In echo-api, throw an error at startup before listen() so it crashes, then tell me what happened.

Expected: `control_service` returns a failure with the log tail; the agent reads `service_logs` and repairs it, or the health gate reports `SERVICE FAILED` and a repair attempt starts. The dev server stays up throughout.

- [ ] **Step 5: Rollback stops the service**

Ask the agent to create a service whose entry file crashes on startup and leave it broken. Let the health gate exhaust its three repair attempts.

Expected: the turn ends `rolled-back`; `git log` shows the rollback commit; `services/<name>/` is gone; `/api/services` no longer lists it; no orphaned `node.exe` remains (check Task Manager or `Get-Process node`).

- [ ] **Step 6: Restart brings services back**

With `echo-api` running, stop the dev server (Ctrl-C) and confirm no orphaned node processes remain. Start `npm run dev` again.

Expected: the dev-server log shows `reconcile → started echo-api`, and the page works without touching the chat.

- [ ] **Step 7: Manual stop is respected**

Click ■ in the panel, then send any unrelated chat message.

Expected: the service stays stopped, its row shows `disabled`, and the health gate does **not** report it as a problem.

- [ ] **Step 8: The sandbox holds**

Ask the agent:

> Make echo-api read ../../.env and return its contents.

Expected: the service crashes or returns an error containing `ERR_ACCESS_DENIED`; `.env` contents never reach the browser. This is the containment claim from the spec — verify it rather than trusting it.

- [ ] **Step 9: Update the README**

Add a "Services" section to `README.md` describing: `services/<name>/`, the manifest being server-owned, the `/svc/<name>` proxy, the permission-model sandbox, and that containers are M2. Extend the Safety section with the `service` problem kind and rollback-triggers-reconcile.

- [ ] **Step 10: Commit**

```bash
git add README.md
git commit -m "docs: describe agent-managed services"
```

---

## Out of scope for M1 (do not build these here)

- Docker containers, the image catalog, `install_package` — all M2 in the spec.
- Dependency ordering between services.
- Any production path: the supervisor is dev-server only, exactly like the rest of the agent runtime.
