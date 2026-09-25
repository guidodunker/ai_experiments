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

test('the type-stripping warning is suppressed so crash logs stay readable', () => {
  assert.ok(spawnArgsFor(ROOT, manifest).args.includes('--disable-warning=ExperimentalWarning'))
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
