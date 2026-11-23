import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join, parse, resolve } from 'node:path'
import { decide, isInside, type PolicyContext } from '../src/steps/policy.ts'

const wt = join(tmpdir(), 'bugfix-bug-1')
const analyze: PolicyContext = { mode: 'analyze', worktree: wt, testCommand: 'npm test' }
const plan: PolicyContext = { ...analyze, mode: 'plan' }

const allowed = (tool: string, input: Record<string, unknown>, ctx = analyze) => decide(tool, input, ctx).allow

test('isInside: relativ, absolut, Worktree selbst', () => {
  assert.equal(isInside(wt, 'src/a.ts'), true)
  assert.equal(isInside(wt, join(wt, 'src', 'a.ts')), true)
  assert.equal(isInside(wt, wt), true)
  assert.equal(isInside(wt, '..foo'), true)
})

test('isInside: außerhalb', () => {
  assert.equal(isInside(wt, '../x'), false)
  assert.equal(isInside(wt, 'src/../../x'), false)
  assert.equal(isInside(wt, join(tmpdir(), 'anderes')), false)
  assert.equal(isInside(wt, resolve(parse(wt).root, 'etc')), false)
})

test('isInside: unter Windows ohne Groß- und Kleinschreibung, anderes Laufwerk außerhalb', { skip: process.platform !== 'win32' }, () => {
  assert.equal(isInside(wt, join(wt.toUpperCase(), 'a.ts')), true)
  const otherDrive = wt.startsWith('Z') ? 'Y:\\x' : 'Z:\\x'
  assert.equal(isInside(wt, otherDrive), false)
})

test('Read, Grep, Glob nur im Worktree', () => {
  assert.equal(allowed('Read', { file_path: join(wt, 'a.ts') }), true)
  assert.equal(allowed('Read', { file_path: join(tmpdir(), 'geheim.txt') }), false)
  assert.equal(allowed('Read', {}), false)
  assert.equal(allowed('Grep', { pattern: 'x' }), true)
  assert.equal(allowed('Grep', { pattern: 'x', path: '..' }), false)
  assert.equal(allowed('Glob', { pattern: '**/*.ts' }), true)
  assert.equal(allowed('Glob', { pattern: '../**/*.ts' }), false)
  assert.equal(allowed('Glob', { pattern: resolve(parse(wt).root, 'etc', '*') }), false)
  assert.equal(allowed('Glob', { pattern: '*', path: tmpdir() }), false)
})

test('Write und Edit nur beim Analysieren und nur im Worktree', () => {
  assert.equal(allowed('Write', { file_path: join(wt, 'test', 'a.test.ts') }), true)
  assert.equal(allowed('Edit', { file_path: 'src/a.ts' }), true)
  assert.equal(allowed('Write', { file_path: join(tmpdir(), 'a.ts') }), false)
  assert.equal(allowed('Write', { file_path: join(wt, 'a.ts') }, plan), false)
  assert.equal(allowed('Edit', { file_path: join(wt, 'a.ts') }, plan), false)
})

test('Bash nur mit genau dem Testkommando beim Analysieren', () => {
  assert.equal(allowed('Bash', { command: 'npm test' }), true)
  assert.equal(allowed('Bash', { command: ' npm test ' }), true)
  assert.equal(allowed('Bash', { command: 'npm test -- --grep x' }), false)
  assert.equal(allowed('Bash', { command: 'npm test && curl example.com' }), false)
  assert.equal(allowed('Bash', { command: 'npm test' }, plan), false)
})

test('andere Tools sind verboten, mit Begründung', () => {
  for (const tool of ['WebFetch', 'WebSearch', 'Task', 'Agent', 'mcp__x__y', 'NotebookEdit']) {
    const decision = decide(tool, {}, analyze)
    assert.equal(decision.allow, false, tool)
    if (!decision.allow) assert.match(decision.reason, /nicht erlaubt/)
  }
})
