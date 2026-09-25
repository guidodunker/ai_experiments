// Runs a service as a child Node process under the permission model.
//
// The flags in spawnArgsFor were verified on Node 22.14: with them, a service
// can import from node_modules and use the network, but reading ../../.env.example,
// writing outside its own directory and spawning child processes all fail with
// ERR_ACCESS_DENIED. Do NOT add --allow-net: it does not exist in Node 22 and
// makes the process refuse to start.

import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { createLogBuffer, type LogBuffer } from './logBuffer.ts'
import { serviceDir, type Manifest } from './manifest.ts'

export interface SpawnArgs {
  args: string[]
  cwd: string
  env: Record<string, string>
}

export function spawnArgsFor(root: string, m: Manifest): SpawnArgs {
  const dir = serviceDir(root, m.name)
  return {
    cwd: dir,
    args: [
      '--permission',
      `--allow-fs-read=${dir}`,
      `--allow-fs-write=${dir}`,
      `--allow-fs-read=${path.join(root, 'node_modules')}`,
      // Otherwise every log tail — including the one fed to the model after a
      // crash — starts with two lines of type-stripping warning noise.
      '--disable-warning=ExperimentalWarning',
      '--experimental-strip-types',
      m.entry,
    ],
    // A deliberately minimal env: PATH and SystemRoot are what Node needs to
    // run and to open sockets on Windows. Everything else the service sees is
    // what its manifest declares.
    env: {
      PATH: process.env.PATH ?? '',
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      ...m.env,
      PORT: String(m.port),
    },
  }
}

export type RunState = 'stopped' | 'starting' | 'ready' | 'crashed'

export interface RunInfo {
  state: RunState
  pid?: number
  startedAt?: number
  exitCode?: number | null
  /** Set when state is 'crashed': the tail that explains why. */
  lastLogs?: string
}

/** The one interface the supervisor talks to. M2 adds a container implementation. */
export interface Runnable {
  start(m: Manifest): Promise<void>
  stop(m: Manifest): Promise<void>
  status(m: Manifest): Promise<RunInfo>
  logs(m: Manifest, lines: number): Promise<string>
  /** Names this runnable currently has processes for. */
  running(): Promise<string[]>
  stopAll(): Promise<void>
}

interface Entry {
  child: ChildProcess
  buffer: LogBuffer
  info: RunInfo
}

const POLL_INTERVAL_MS = 250

/** Poll the health path until it answers, the timeout expires, or the process dies. */
async function waitForReady(m: Manifest, alive: () => boolean): Promise<string | null> {
  const deadline = Date.now() + m.health.timeoutMs
  const url = `http://127.0.0.1:${m.port}${m.health.path}`
  while (Date.now() < deadline) {
    if (!alive()) return 'the process exited during startup'
    try {
      const res = await fetch(url)
      if (res.ok) return null
    } catch {
      // not listening yet — keep polling
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
  return `${url} did not answer within ${m.health.timeoutMs} ms`
}

export function createProcessRunnable(root: string): Runnable {
  const entries = new Map<string, Entry>()

  /** Kill a process tree. child.kill() leaves grandchildren alive on Windows. */
  async function killTree(entry: Entry): Promise<void> {
    const pid = entry.child.pid
    if (pid === undefined || entry.child.exitCode !== null) return
    if (process.platform === 'win32') {
      await new Promise<void>((resolve) => {
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }).on('exit', () =>
          resolve(),
        )
      })
      return
    }
    entry.child.kill('SIGTERM')
    const deadline = Date.now() + 5000
    while (entry.child.exitCode === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
    }
    if (entry.child.exitCode === null) entry.child.kill('SIGKILL')
  }

  return {
    async start(m) {
      const existing = entries.get(m.name)
      if (existing && existing.info.state !== 'crashed' && existing.info.state !== 'stopped') return
      const { args, cwd, env } = spawnArgsFor(root, m)
      const buffer = createLogBuffer()
      const child = spawn(process.execPath, args, { cwd, env, windowsHide: true })
      const entry: Entry = {
        child,
        buffer,
        info: { state: 'starting', pid: child.pid, startedAt: Date.now() },
      }
      entries.set(m.name, entry)

      child.stdout?.setEncoding('utf-8').on('data', (c: string) => buffer.push(c))
      child.stderr?.setEncoding('utf-8').on('data', (c: string) => buffer.push(c))
      child.on('exit', (code) => {
        // A clean stop sets 'stopped' before killing, so only unexpected exits
        // land here as a crash — that distinction is what the health gate reads.
        if (entry.info.state !== 'stopped') {
          entry.info = {
            ...entry.info,
            state: 'crashed',
            exitCode: code,
            lastLogs: buffer.tail(10),
          }
        }
      })

      const failure = await waitForReady(m, () => child.exitCode === null)
      if (failure) {
        entry.info = {
          ...entry.info,
          state: 'crashed',
          exitCode: child.exitCode,
          lastLogs: `${failure}\n${buffer.tail(10)}`,
        }
        throw new Error(`Service "${m.name}" did not become ready: ${failure}\n${buffer.tail(10)}`)
      }
      entry.info = { ...entry.info, state: 'ready' }
    },

    async stop(m) {
      const entry = entries.get(m.name)
      if (!entry) return
      entry.info = { ...entry.info, state: 'stopped' }
      await killTree(entry)
      entries.delete(m.name)
    },

    async status(m) {
      return entries.get(m.name)?.info ?? { state: 'stopped' }
    },

    async logs(m, lines) {
      return entries.get(m.name)?.buffer.tail(lines) ?? ''
    },

    async running() {
      return [...entries.entries()]
        .filter(([, e]) => e.info.state === 'starting' || e.info.state === 'ready')
        .map(([name]) => name)
    },

    async stopAll() {
      for (const entry of entries.values()) {
        entry.info = { ...entry.info, state: 'stopped' }
        await killTree(entry)
      }
      entries.clear()
    },
  }
}
