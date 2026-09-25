// Module-level chat store. The agent loop and all chat state live here, NOT in
// React component state: when the agent edits src/App.tsx, HMR can remount the
// Chat component mid-turn, which would orphan an in-flight loop and its state
// setters. This module is only invalidated if files under src/chat or
// src/agent change — which the agent cannot do (they are write-protected) —
// so a remounted Chat simply re-subscribes and streaming continues.

import { subscribe as subscribeHealth } from '../agent/health.ts'
import { signatureOf } from '../agent/healthReport.ts'
import { runAgentTurn } from '../agent/loop.ts'
import { SYSTEM_PROMPT } from '../agent/systemPrompt.ts'
import type { ChatMessage, TranscriptItem } from '../agent/types.ts'

const STORE_WIRE = 'agent.wire'
const STORE_TRANSCRIPT = 'agent.transcript'
const STORE_SESSION = 'agent.session'

export interface ChatState {
  transcript: TranscriptItem[]
  busy: boolean
  /** Cumulative cost (USD) and tokens across the whole session. */
  sessionCost: number
  sessionTokens: number
}

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

const freshWire = (): ChatMessage[] => [{ role: 'system', content: SYSTEM_PROMPT }]

// A persisted "streaming" flag means a previous page load ended mid-turn —
// clear it so no phantom cursor blinks forever.
const restoredTranscript = loadJson<TranscriptItem[]>(STORE_TRANSCRIPT, []).map((it) =>
  it.kind === 'assistant' && it.streaming ? { ...it, streaming: false } : it,
)

const restoredSession = loadJson<{ cost: number; tokens: number }>(STORE_SESSION, {
  cost: 0,
  tokens: 0,
})

let wire: ChatMessage[] = loadJson(STORE_WIRE, freshWire())
let state: ChatState = {
  transcript: restoredTranscript,
  busy: false,
  sessionCost: restoredSession.cost,
  sessionTokens: restoredSession.tokens,
}
const listeners = new Set<() => void>()

// --- watchdog state -------------------------------------------------------
// A crash right after a turn is unambiguously the agent's fresh damage and is
// repaired automatically. Later crashes only offer a button: no model call
// while the user is doing something else entirely.
const AUTO_REPAIR_WINDOW_MS = 30_000
const DEBOUNCE_MS = 1000

let lastModel = ''
let turnEndedAt = 0
let agentHasWritten = false
let autoRepairsInARow = 0
const handledSignatures = new Set<string>()
let debounceTimer: ReturnType<typeof setTimeout> | undefined

function setState(patch: Partial<ChatState>): void {
  state = { ...state, ...patch }
  localStorage.setItem(STORE_TRANSCRIPT, JSON.stringify(state.transcript))
  localStorage.setItem(STORE_WIRE, JSON.stringify(wire))
  localStorage.setItem(
    STORE_SESSION,
    JSON.stringify({ cost: state.sessionCost, tokens: state.sessionTokens }),
  )
  for (const listener of listeners) listener()
}

function patchItem(id: string, patch: Partial<TranscriptItem>): void {
  setState({
    transcript: state.transcript.map((it) =>
      it.id === id ? ({ ...it, ...patch } as TranscriptItem) : it,
    ),
  })
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getSnapshot(): ChatState {
  return state
}

export async function sendMessage(text: string, model: string): Promise<void> {
  if (state.busy) return
  lastModel = model
  const turnId = `turn_${Date.now()}`
  wire.push({ role: 'user', content: text })
  setState({ busy: true, transcript: [...state.transcript, { kind: 'user', id: turnId, text }] })
  try {
    await runAgentTurn({
      model,
      messages: wire,
      turnId,
      callbacks: {
        onAssistantStart: (id) =>
          setState({
            transcript: [...state.transcript, { kind: 'assistant', id, text: '', streaming: true }],
          }),
        onAssistantDelta: (id, delta) =>
          setState({
            transcript: state.transcript.map((it) =>
              it.id === id && it.kind === 'assistant' ? { ...it, text: it.text + delta } : it,
            ),
          }),
        onAssistantDone: (id) => patchItem(id, { streaming: false }),
        onToolCall: (id, name, args) =>
          setState({ transcript: [...state.transcript, { kind: 'tool', id, name, args }] }),
        onToolResult: (id, result, isError) => patchItem(id, { result, isError }),
        onHealth: (id, status, text) => {
          agentHasWritten = true
          const existing = state.transcript.find((it) => it.id === id)
          if (existing) {
            patchItem(id, { status, text } as Partial<TranscriptItem>)
            return
          }
          setState({ transcript: [...state.transcript, { kind: 'health', id, status, text }] })
        },
        onTurnUsage: (usd, tokens) => {
          if (tokens === 0 && usd === 0) return
          setState({
            transcript: [
              ...state.transcript,
              { kind: 'cost', id: `cost_${Date.now()}`, usd, tokens },
            ],
            sessionCost: state.sessionCost + usd,
            sessionTokens: state.sessionTokens + tokens,
          })
        },
      },
    })
  } catch (err) {
    setState({
      transcript: [
        ...state.transcript,
        {
          kind: 'error',
          id: `err_${Date.now()}`,
          text: err instanceof Error ? err.message : String(err),
        },
      ],
    })
  } finally {
    // Commit whatever this turn produced, labeled with the prompt text. The
    // server skips the commit if the turn wrote nothing (e.g. a plain answer).
    await commitTurn(text)
    turnEndedAt = Date.now()
    setState({ busy: false })
  }
}

async function commitTurn(message: string): Promise<void> {
  try {
    await fetch('/api/git/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    })
  } catch {
    // A failed commit must not break the chat; it's logged server-side.
  }
}

export function newChat(): void {
  if (state.busy) return
  wire = freshWire()
  agentHasWritten = false
  autoRepairsInARow = 0
  handledSignatures.clear()
  setState({ transcript: [], sessionCost: 0, sessionTokens: 0 })
}

/** Start a repair turn for a problem the watchdog found after the turn ended. */
export function repairNow(prompt: string): void {
  if (state.busy || lastModel.length === 0) return
  void sendMessage(prompt, lastModel)
}

function watchdogPrompt(text: string): string {
  return [
    'AUTOMATIC WATCHDOG REPORT — this is not a user message.',
    'The app crashed in the browser after your last turn:',
    '',
    text,
    '',
    'Read the files you changed, find the cause and fix it with write_file.',
  ].join('\n')
}

subscribeHealth((problem) => {
  if (!agentHasWritten) return // nothing the agent did can be at fault yet
  const signature = signatureOf([problem])
  if (handledSignatures.has(signature)) return
  handledSignatures.add(signature)

  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    if (state.busy) return
    const where = problem.file ? `${problem.file}: ` : ''
    const text = `${where}${problem.message}`
    const fresh = Date.now() - turnEndedAt <= AUTO_REPAIR_WINDOW_MS

    if (fresh && autoRepairsInARow === 0) {
      autoRepairsInARow += 1
      setState({
        transcript: [
          ...state.transcript,
          {
            kind: 'health',
            id: `wd_${Date.now()}`,
            status: 'repairing',
            text: `App crashed after the turn — repairing automatically: ${text}`,
          },
        ],
      })
      repairNow(watchdogPrompt(text))
      return
    }

    // Too late, or the previous automatic repair already failed: ask first.
    setState({
      transcript: [
        ...state.transcript,
        {
          kind: 'broken',
          id: `wd_${Date.now()}`,
          text:
            autoRepairsInARow > 0
              ? `Still broken after an automatic repair: ${text} — you can retry, or restore an older state at /recovery.`
              : `The app is broken: ${text}`,
          prompt: watchdogPrompt(text),
        },
      ],
    })
  }, DEBOUNCE_MS)
})
