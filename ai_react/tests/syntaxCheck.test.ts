import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkSyntax } from '../server/syntaxCheck.ts'

// Position 35 in this exact input is verified ground truth from tsc.
test('rejects unparsable JSX and names line and column', () => {
  const msg = checkSyntax('src/Broken.tsx', 'export function A(){ return <div>{x</div> }')
  assert.equal(msg, "Syntax error in src/Broken.tsx (line 1, column 36): '}' expected.")
})

test('accepts a pure type error — that is tsc’s job, not the gate’s', () => {
  assert.equal(checkSyntax('src/T.ts', 'export const x: string = 1\n'), null)
})

test('accepts valid TSX', () => {
  assert.equal(checkSyntax('src/Ok.tsx', 'export const A = () => <div className="a">ok</div>\n'), null)
})

test('accepts multi-line TSX with hooks', () => {
  const code = [
    "import { useState } from 'react'",
    'export function C() {',
    '  const [n, setN] = useState(0)',
    '  return <button onClick={() => setN(n + 1)}>{n}</button>',
    '}',
  ].join('\n')
  assert.equal(checkSyntax('src/C.tsx', code), null)
})

test('ignores files that are not JS or TS', () => {
  assert.equal(checkSyntax('src/App.css', '.a { color: red\n'), null)
  assert.equal(checkSyntax('README.md', '# nope {{{\n'), null)
})
