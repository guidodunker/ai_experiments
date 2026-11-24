import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatPost, parseChat } from '../src/parser.ts'

test('leere Datei ergibt keine Threads', () => {
  assert.deepEqual(parseChat(''), [])
})

test('Top-Posts und Antworten mit Ebenen', () => {
  const text = '> Die Suche ist langsam.\n>> oje\n>>> wirklich\n> Neues Thema\n'
  assert.deepEqual(parseChat(text), [
    {
      id: '0',
      index: 0,
      top: { level: 1, text: 'Die Suche ist langsam.' },
      replies: [
        { level: 2, text: 'oje' },
        { level: 3, text: 'wirklich' },
      ],
    },
    { id: '1', index: 1, top: { level: 1, text: 'Neues Thema' }, replies: [] },
  ])
})

test('Zeilen ohne Präfix setzen den vorigen Post fort', () => {
  const text = '> Zeile eins\nZeile zwei\n\n>> Antwort\nmehr\n'
  const [thread] = parseChat(text)
  assert.equal(thread?.top.text, 'Zeile eins\nZeile zwei')
  assert.equal(thread?.replies[0]?.text, 'Antwort\nmehr')
})

test('Text und Antworten vor dem ersten Top-Post werden ignoriert', () => {
  const text = 'Kopfzeile\n>> verirrte Antwort\n> Erster Post'
  assert.deepEqual(parseChat(text), [
    { id: '0', index: 0, top: { level: 1, text: 'Erster Post' }, replies: [] },
  ])
})

test('Windows-Zeilenenden und fehlendes Leerzeichen', () => {
  assert.deepEqual(parseChat('>Bug\r\n>>ja\r\n'), [
    { id: '0', index: 0, top: { level: 1, text: 'Bug' }, replies: [{ level: 2, text: 'ja' }] },
  ])
})

test('formatPost setzt das Präfix vor jede Zeile', () => {
  assert.equal(formatPost({ level: 2, text: 'a\nb' }), '>> a\n>> b')
})
