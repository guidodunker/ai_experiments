import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { chooseStore } from '../src/store/config.ts'
import { fakeGitHub } from './helpers/fake-github.ts'

const ROOT = join('projekt', 'agent')
const GITHUB = { TICKET_STORE: 'github', GITHUB_TOKEN: 'ghp_1', GITHUB_REPO: 'o/r' }

test('ohne TICKET_STORE: Dateien', async () => {
  const store = await chooseStore({}, ROOT)
  assert.ok(!('error' in store))
  assert.equal(store.kind, 'datei')
})

test('github mit allen Variablen und erreichbarem Repo', async () => {
  const made: string[] = []
  const store = await chooseStore(GITHUB, ROOT, (token, repo) => {
    made.push(`${token} ${repo}`)
    return fakeGitHub().api
  })
  assert.ok(!('error' in store))
  assert.equal(store.kind, 'github')
  assert.deepEqual(made, ['ghp_1 o/r'])
})

test('github ohne Variable nennt sie', async () => {
  assert.deepEqual(await chooseStore({ ...GITHUB, GITHUB_TOKEN: '' }, ROOT), {
    error: 'GITHUB_TOKEN fehlt. Trage es in .env ein (siehe .env.example).',
  })
})

test('GITHUB_REPO in falscher Form', async () => {
  assert.deepEqual(await chooseStore({ ...GITHUB, GITHUB_REPO: 'https://github.com/o/r' }, ROOT), {
    error: 'GITHUB_REPO=https://github.com/o/r hat nicht die Form owner/name.',
  })
})

test('Repo nicht erreichbar', async () => {
  const api = {
    ...fakeGitHub().api,
    getRepo: async () => Promise.reject(new Error('GitHub GET /repos/o/r: 401 Bad credentials')),
  }
  assert.deepEqual(await chooseStore(GITHUB, ROOT, () => api), {
    error: 'GitHub-Repo o/r nicht erreichbar: GitHub GET /repos/o/r: 401 Bad credentials',
  })
})

test('unbekannter Store', async () => {
  assert.deepEqual(await chooseStore({ TICKET_STORE: 'jira' }, ROOT), {
    error: 'TICKET_STORE=jira ist unbekannt. Erlaubt: datei, github.',
  })
})
