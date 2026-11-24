import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { runFile, runShell, tailLines, withoutSecrets } from '../src/command.ts'

test('withoutSecrets entfernt Tokens und Schlüssel, lässt den Rest', () => {
  assert.deepEqual(
    withoutSecrets({
      PATH: 'p',
      GITHUB_TOKEN: 'g',
      OPENROUTER_API_KEY: 'o',
      ANTHROPIC_API_KEY: 'a',
      ANTHROPIC_AUTH_TOKEN: 't',
      SLACK_BOT_TOKEN: 's',
      SLACK_APP_TOKEN: 's2',
      TARGET_DIR: 'd',
    }),
    { PATH: 'p', TARGET_DIR: 'd' },
  )
})

test('runShell gibt GITHUB_TOKEN nicht an das Testkommando weiter', async () => {
  process.env.GITHUB_TOKEN = 'geheim'
  try {
    const result = await runShell(`node -e "console.log(process.env.GITHUB_TOKEN || 'leer')"`, tmpdir())
    assert.equal(result.stdout.trim(), 'leer')
  } finally {
    delete process.env.GITHUB_TOKEN
  }
})

test('runShell liefert Exit-Code und beide Ausgabekanäle', async () => {
  const result = await runShell(`node -e "console.log('aus'); console.error('err'); process.exit(3)"`, tmpdir())
  assert.equal(result.code, 3)
  assert.match(result.output, /aus/)
  assert.match(result.output, /err/)
  assert.equal(result.stdout.trim(), 'aus')
})

test('runFile übergibt Argumente ohne Shell', async () => {
  const result = await runFile('node', ['-e', 'console.log(process.argv[1])', 'a b&c'], tmpdir())
  assert.equal(result.code, 0)
  assert.equal(result.stdout.trim(), 'a b&c')
})

test('runFile: unbekanntes Verzeichnis wirft', async () => {
  await assert.rejects(runFile('node', ['-v'], 'Z:\\gibt\\es\\nicht'))
})

test('tailLines liefert die letzten Zeilen ohne Leerzeilen am Ende', () => {
  assert.equal(tailLines('a\nb\r\nc\nd\n\n', 2), 'c\nd')
  assert.equal(tailLines('a', 5), 'a')
})
