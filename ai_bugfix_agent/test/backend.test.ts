import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { chooseBackend } from '../src/steps/backend.ts'

const ROOT = join('projekt', 'agent')

test('Default openrouter: Umgebung zeigt auf OpenRouter, Login und Geheimnisse sind ausgesperrt', () => {
  const choice = chooseBackend(
    { OPENROUTER_API_KEY: 'sk-or-1', PATH: 'x', ANTHROPIC_API_KEY: 'sk-ant-echt', GITHUB_TOKEN: 'g', SLACK_BOT_TOKEN: 's' },
    ROOT,
  )
  assert.ok(!('error' in choice))
  assert.equal(choice.backend, 'openrouter')
  assert.equal(choice.model, 'anthropic/claude-opus-5')
  assert.equal(choice.configDir, join(ROOT, '.claude-steps'))
  assert.deepEqual(choice.sessionEnv, {
    PATH: 'x',
    ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
    ANTHROPIC_AUTH_TOKEN: 'sk-or-1',
    ANTHROPIC_API_KEY: '',
    CLAUDE_CONFIG_DIR: join(ROOT, '.claude-steps'),
  })
})

test('openrouter ohne Key: Fehler statt Rückfall auf den Login', () => {
  assert.deepEqual(chooseBackend({ OPENROUTER_API_KEY: ' ' }, ROOT), {
    error: 'OPENROUTER_API_KEY fehlt. npm run steps läuft über OpenRouter (STEPS_BACKEND=openrouter).',
  })
})

test('STEPS_MODEL überschreibt den Default', () => {
  const choice = chooseBackend({ OPENROUTER_API_KEY: 'k', STEPS_MODEL: 'anthropic/claude-sonnet-5' }, ROOT)
  assert.ok(!('error' in choice))
  assert.equal(choice.model, 'anthropic/claude-sonnet-5')
})

test('claude-login: Umgebung ohne Geheimnisse, Modell ohne Präfix', () => {
  const choice = chooseBackend({ STEPS_BACKEND: 'claude-login', GITHUB_TOKEN: 'g', PATH: 'x' }, ROOT)
  assert.ok(!('error' in choice))
  assert.equal(choice.backend, 'claude-login')
  assert.equal(choice.model, 'claude-opus-5')
  assert.deepEqual(choice.sessionEnv, { STEPS_BACKEND: 'claude-login', PATH: 'x' })
  assert.equal(choice.configDir, undefined)
})

test('claude-login behält ANTHROPIC_API_KEY', () => {
  const choice = chooseBackend({ STEPS_BACKEND: 'claude-login', ANTHROPIC_API_KEY: 'sk-ant' }, ROOT)
  assert.ok(!('error' in choice))
  assert.equal(choice.sessionEnv.ANTHROPIC_API_KEY, 'sk-ant')
})

test('unbekanntes Backend', () => {
  assert.deepEqual(chooseBackend({ STEPS_BACKEND: 'bedrock' }, ROOT), {
    error: 'STEPS_BACKEND=bedrock ist unbekannt. Erlaubt: openrouter, claude-login.',
  })
})
