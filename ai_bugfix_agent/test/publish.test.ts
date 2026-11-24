import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from '../src/git.ts'
import { githubPublisher, pushAuth, redact } from '../src/steps/publish.ts'
import { fakeGitHub } from './helpers/fake-github.ts'
import { createRepo } from './helpers/repo.ts'

const TOKEN = 'github_pat_geheim'

test('pushAuth: Token nur in der Umgebung, Credential-Helper aus', () => {
  const auth = pushAuth(TOKEN)
  assert.deepEqual(auth.args, ['-c', 'credential.helper='])
  assert.ok(!auth.args.join(' ').includes(TOKEN))
  assert.equal(auth.env.GIT_TERMINAL_PROMPT, '0')
  assert.equal(auth.env.GIT_CONFIG_COUNT, '1')
  assert.equal(auth.env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader')
  assert.equal(
    auth.env.GIT_CONFIG_VALUE_0,
    `Authorization: Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`,
  )
})

test('redact entfernt Token und Base64-Form', () => {
  const basic = Buffer.from(`x-access-token:${TOKEN}`).toString('base64')
  assert.equal(redact(`a ${TOKEN} b ${basic} c`, TOKEN), 'a *** b *** c')
})

test('push und remoteHead gegen ein lokales Bare-Repo', async () => {
  const repo = await createRepo({ 'a.txt': 'a\n' })
  await git(repo, ['branch', 'bugfix/issue-7'])
  const bare = await mkdtemp(join(tmpdir(), 'bugagent-bare-'))
  await git(bare, ['init', '-q', '--bare'])
  const publisher = githubPublisher(TOKEN, 'o/r', fakeGitHub().api, { url: bare })
  assert.equal(await publisher.remoteHead('bugfix/issue-7'), undefined)
  await publisher.push(repo, 'bugfix/issue-7')
  assert.equal(await publisher.remoteHead('bugfix/issue-7'), (await git(repo, ['rev-parse', 'bugfix/issue-7'])).trim())
})

test('gescheiterter Push wirft ohne Token im Text', async () => {
  const repo = await createRepo({ 'a.txt': 'a\n' })
  const publisher = githubPublisher(TOKEN, 'o/r', fakeGitHub().api, { url: join(tmpdir(), 'gibt-es-nicht-bugagent') })
  await assert.rejects(publisher.push(repo, 'main'), (error: Error) => {
    assert.match(error.message, /git push fehlgeschlagen/)
    assert.ok(!error.message.includes(TOKEN))
    return true
  })
})

test('findOpenPull und createPull gehen an die API', async () => {
  const gh = fakeGitHub()
  const publisher = githubPublisher(TOKEN, 'o/r', gh.api)
  const url = await publisher.createPull({ title: 'T', head: 'b', base: 'main', body: 'B' })
  assert.equal(await publisher.findOpenPull('b'), url)
})
