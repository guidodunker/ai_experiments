import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  ManifestError,
  buildManifest,
  listManifests,
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
        {
          name: 'api',
          kind: 'process',
          entry: 'index.ts',
          env: { NODE_OPTIONS: '--allow-fs-write=/' },
        },
        4001,
      ),
    { message: /reserved/ },
  )
  assert.throws(
    () =>
      buildManifest({ name: 'api', kind: 'process', entry: 'index.ts', env: { PORT: '9' } }, 4001),
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
    {
      name: 'notes-api',
      kind: 'process',
      entry: 'index.ts',
      env: { DATABASE_URL: 'x' },
      health: { path: '/up', timeoutMs: 2000 },
    },
    4002,
  )
  assert.deepEqual(parseManifest(serialiseManifest(m)), m)
})

test('parse keeps enabled:false and rejects a manifest without a port', () => {
  assert.equal(
    parseManifest('{"name":"api","kind":"process","entry":"i.ts","port":4001,"enabled":false}')
      .enabled,
    false,
  )
  assert.throws(() => parseManifest('{"name":"api","kind":"process","entry":"i.ts"}'), {
    message: /port/,
  })
  assert.throws(() => parseManifest('not json'), { message: /valid JSON/ })
})

test('listing skips directories that hold no manifest, and keeps the valid ones', async () => {
  // A rollback can leave an empty services/<name>/ behind. Listing must not
  // warn about it on every status poll, and must not choke on it either.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-react-services-'))
  try {
    await fs.mkdir(path.join(root, 'services', 'leftover'), { recursive: true })
    await fs.mkdir(path.join(root, 'services', 'good'), { recursive: true })
    await fs.writeFile(
      path.join(root, 'services', 'good', 'service.json'),
      serialiseManifest(buildManifest({ name: 'good', kind: 'process', entry: 'index.ts' }, 4005)),
      'utf-8',
    )
    const found = await listManifests(root)
    assert.deepEqual(
      found.map((m) => m.name),
      ['good'],
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('listing a project without any services directory returns nothing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-react-empty-'))
  try {
    assert.deepEqual(await listManifests(root), [])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
