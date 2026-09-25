import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { loadEnv, type Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { recoveryHtml } from './recoveryPage.ts'
import { probeModules } from './healthProbe.ts'
import { checkSyntax } from './syntaxCheck.ts'
import { runTypecheck } from './tscCheck.ts'
import { handleServiceRoutes } from './services/routes.ts'
import { createSupervisor, type Supervisor } from './services/supervisor.ts'

const execFileAsync = promisify(execFile)

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

// Commits made by the agent runtime carry this author so /api/git/log can
// tell them apart from the user's own commits.
const AGENT_AUTHOR = 'ai agent <agent@ai-react.local>'
const AGENT_AUTHOR_EMAIL = 'agent@ai-react.local'
const SNAPSHOT_MESSAGE = 'agent snapshot (pre-modification)'

// Directories the agent must never see or touch.
const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'dist', '.idea', '.junie'])
// Files the agent must never read or write.
const PROTECTED_FILES = [/^\.env/i, /^package-lock\.json$/i]
// The agent's own runtime: readable (for context) but never writable, so the
// agent cannot break or subvert the chat UI, its tools, or the sandbox itself.
const WRITE_PROTECTED_DIRS = ['server', 'src/agent', 'src/chat', 'tests']
const WRITE_PROTECTED_FILES = [
  'vite.config.ts',
  'src/main.tsx',
  'index.html',
  'package.json',
  'tsconfig.json',
  'tsconfig.app.json',
  'tsconfig.node.json',
]

// services/<name>/service.json is server-owned: it may only be created through
// /api/services/create, which validates it against the schema and allocates the
// port. Source files in the same directory stay writable for the agent.
const WRITE_PROTECTED_PATTERNS = [
  /^services\/[^/]+\/service\.json$/,
  /^services\/[^/]+\/package\.json$/,
]

function isWriteProtected(root: string, abs: string): boolean {
  const rel = path.relative(root, abs).split(path.sep).join('/')
  if (WRITE_PROTECTED_FILES.includes(rel)) return true
  if (WRITE_PROTECTED_PATTERNS.some((re) => re.test(rel))) return true
  return WRITE_PROTECTED_DIRS.some((dir) => rel === dir || rel.startsWith(dir + '/'))
}

interface FsEntry {
  path: string
  type: 'file' | 'dir'
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function logLine(msg: string): void {
  const time = new Date().toLocaleTimeString('en-GB', { hour12: false })
  console.log(`${time} [agent] ${msg}`)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

/**
 * Resolve a project-relative path and enforce the sandbox: the result must
 * stay inside the project root and may not touch excluded dirs or protected
 * files. Returns the absolute path, or null if the path is not allowed.
 */
function safeResolve(root: string, relPath: string): string | null {
  if (typeof relPath !== 'string' || relPath.length === 0) return null
  const abs = path.resolve(root, relPath)
  if (abs !== root && !abs.startsWith(root + path.sep)) return null
  const rel = path.relative(root, abs)
  const segments = rel.split(path.sep)
  if (segments.some((s) => EXCLUDED_DIRS.has(s))) return null
  const base = segments[segments.length - 1] ?? ''
  if (PROTECTED_FILES.some((re) => re.test(base))) return null
  return abs
}

async function listFiles(root: string, dir: string, out: FsEntry[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry.name)) continue
    if (PROTECTED_FILES.some((re) => re.test(entry.name))) continue
    const abs = path.join(dir, entry.name)
    const rel = path.relative(root, abs).split(path.sep).join('/')
    if (entry.isDirectory()) {
      out.push({ path: rel, type: 'dir' })
      await listFiles(root, abs, out)
    } else if (entry.isFile()) {
      out.push({ path: rel, type: 'file' })
    }
  }
}

/**
 * Stage everything and commit with `message`. Returns the new short hash, or
 * null if the working tree was clean (nothing to commit) or git failed.
 */
async function gitCommitAll(root: string, message: string): Promise<string | null> {
  try {
    await execFileAsync('git', ['add', '-A'], { cwd: root })
    const { stdout: status } = await execFileAsync('git', ['status', '--porcelain'], { cwd: root })
    if (status.trim().length === 0) return null // nothing to commit
    await execFileAsync('git', ['commit', '-m', message, '--no-verify', '--author', AGENT_AUTHOR], {
      cwd: root,
    })
    const { stdout: hash } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: root,
    })
    return hash.trim()
  } catch (err) {
    console.warn('[agent] git commit failed:', err)
    return null
  }
}

/** Short hash of the current HEAD commit, or null if git is unavailable. */
async function gitHead(root: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root })
    return stdout.trim()
  } catch {
    return null
  }
}

export function agentPlugin(): Plugin {
  let root = ''
  let apiKey = ''
  // Turn id of the last snapshot, so we snapshot only once per user turn, plus
  // its commit hash so a failed turn can be rolled back to exactly that state.
  let lastSnapshotTurn = ''
  let lastSnapshot: { turnId: string; hash: string } | null = null
  let supervisor: Supervisor | null = null

  return {
    name: 'agent-middleware',
    configResolved(config) {
      // Vite reports root with forward slashes even on Windows; normalize to
      // native separators so the path-sandbox comparisons below work.
      root = path.resolve(config.root)
      apiKey = loadEnv(config.mode, config.root, '').OPENROUTER_API_KEY ?? ''
    },
    configureServer(server) {
      supervisor = createSupervisor(root)
      // Bring declared services back after a dev-server restart. Failures are
      // logged, never fatal — a broken service must not stop the dev server.
      void supervisor.reconcile().then(
        (plan) =>
          plan.toStart.length > 0 && logLine(`reconcile → started ${plan.toStart.join(', ')}`),
        (err) => logLine(`reconcile failed: ${String(err)}`),
      )
      // Processes are children of this server; never leave them orphaned.
      server.httpServer?.once('close', () => void supervisor?.shutdown())

      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0]

        // The recovery page is plain HTML served straight from this middleware,
        // bypassing the SPA entirely: it must stay reachable even when the
        // agent has broken the React app.
        if (url === '/recovery' && req.method === 'GET') {
          res.statusCode = 200
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          return res.end(recoveryHtml)
        }

        // Service routes are caught here rather than inside handle(), because
        // /svc/ is not under /api/ and would otherwise fall through to Vite.
        if (supervisor && (url.startsWith('/svc/') || url.startsWith('/api/services'))) {
          const active = supervisor
          void handleServiceRoutes(req, res, url, active, logLine).catch((err) => {
            console.error('[agent] service route error:', err)
            if (!res.headersSent) sendJson(res, 500, { error: String(err) })
            else res.end()
          })
          return
        }

        if (!url.startsWith('/api/')) return next()

        const handle = async () => {
          if (url === '/api/chat' && req.method === 'POST') {
            if (!apiKey) {
              logLine('chat → rejected: OPENROUTER_API_KEY is not set')
              return sendJson(res, 500, {
                error:
                  'OPENROUTER_API_KEY is not set. Create a .env.example file (see .env.example) and restart the dev server.',
              })
            }
            const body = await readBody(req)
            let model = '?'
            try {
              model = JSON.parse(body).model ?? '?'
            } catch {
              /* log with unknown model */
            }
            const upstream = await fetch(OPENROUTER_URL, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'http://localhost:5173',
                'X-Title': 'ai-react internal coding agent',
              },
              body,
            })
            logLine(`chat model=${model} → HTTP ${upstream.status}`)
            res.statusCode = upstream.status
            res.setHeader(
              'Content-Type',
              upstream.headers.get('content-type') ?? 'application/json',
            )
            if (!upstream.body) return res.end()
            const reader = upstream.body.getReader()
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              res.write(value)
            }
            return res.end()
          }

          if (url === '/api/fs/list' && req.method === 'GET') {
            const entries: FsEntry[] = []
            await listFiles(root, root, entries)
            logLine(`list_files → ${entries.length} entries`)
            return sendJson(res, 200, { entries })
          }

          if (url === '/api/fs/read' && req.method === 'POST') {
            const { path: relPath } = JSON.parse(await readBody(req))
            const abs = safeResolve(root, relPath)
            if (!abs) {
              logLine(`read ${relPath} → DENIED (outside sandbox)`)
              return sendJson(res, 403, { error: `Path not allowed: ${relPath}` })
            }
            try {
              const content = await fs.readFile(abs, 'utf-8')
              logLine(`read ${relPath} (${content.length} chars)`)
              return sendJson(res, 200, { content })
            } catch {
              logLine(`read ${relPath} → not found`)
              return sendJson(res, 404, { error: `File not found: ${relPath}` })
            }
          }

          if (url === '/api/fs/write' && req.method === 'POST') {
            const { path: relPath, content, turnId } = JSON.parse(await readBody(req))
            const abs = safeResolve(root, relPath)
            if (!abs) {
              logLine(`write ${relPath} → DENIED (outside sandbox)`)
              return sendJson(res, 403, { error: `Path not allowed: ${relPath}` })
            }
            if (isWriteProtected(root, abs)) {
              logLine(`write ${relPath} → DENIED (agent runtime is read-only)`)
              return sendJson(res, 403, {
                error: `Path is read-only (agent runtime is protected): ${relPath}`,
              })
            }
            if (typeof content !== 'string') {
              return sendJson(res, 400, { error: 'content must be a string' })
            }
            const syntaxError = checkSyntax(relPath, content)
            if (syntaxError) {
              logLine(`write ${relPath} → REJECTED (${syntaxError})`)
              return sendJson(res, 422, {
                error:
                  `${syntaxError} — nothing was written. ` +
                  'Send the COMPLETE corrected file content in a new write_file call.',
              })
            }
            let snapshot: string | null = null
            if (typeof turnId === 'string' && turnId !== lastSnapshotTurn) {
              lastSnapshotTurn = turnId
              snapshot = await gitCommitAll(root, SNAPSHOT_MESSAGE)
              // A clean working tree means there was nothing to snapshot — the
              // state before this write is simply HEAD. Without this fallback
              // the rollback anchor would be missing in the most common case.
              const anchor = snapshot ?? (await gitHead(root))
              lastSnapshot = anchor ? { turnId, hash: anchor } : null
            }
            await fs.mkdir(path.dirname(abs), { recursive: true })
            await fs.writeFile(abs, content, 'utf-8')
            logLine(
              `write ${relPath} (${content.length} chars)` +
                (snapshot ? ` [snapshot ${snapshot}]` : ''),
            )
            return sendJson(res, 200, { ok: true, snapshot })
          }

          if (url === '/api/fs/delete' && req.method === 'POST') {
            const { path: relPath, turnId } = JSON.parse(await readBody(req))
            const abs = safeResolve(root, relPath)
            if (!abs) {
              logLine(`delete ${relPath} → DENIED (outside sandbox)`)
              return sendJson(res, 403, { error: `Path not allowed: ${relPath}` })
            }
            if (isWriteProtected(root, abs)) {
              logLine(`delete ${relPath} → DENIED (agent runtime is protected)`)
              return sendJson(res, 403, { error: `Path is read-only: ${relPath}` })
            }
            let snapshot: string | null = null
            if (typeof turnId === 'string' && turnId !== lastSnapshotTurn) {
              lastSnapshotTurn = turnId
              snapshot = await gitCommitAll(root, SNAPSHOT_MESSAGE)
              const anchor = snapshot ?? (await gitHead(root))
              lastSnapshot = anchor ? { turnId, hash: anchor } : null
            }
            try {
              await fs.rm(abs, { recursive: false, force: false })
            } catch {
              logLine(`delete ${relPath} → not found`)
              return sendJson(res, 404, { error: `File not found: ${relPath}` })
            }
            logLine(`delete ${relPath}${snapshot ? ` [snapshot ${snapshot}]` : ''}`)
            return sendJson(res, 200, { ok: true, snapshot })
          }

          if (url === '/api/health/probe' && req.method === 'POST') {
            const { paths } = JSON.parse(await readBody(req))
            const requested = Array.isArray(paths)
              ? paths.filter((p: unknown): p is string => typeof p === 'string')
              : []
            // App.tsx is always probed: it is the module every page hangs off.
            const targets = ['src/App.tsx', ...requested].filter(
              (p, i, all) => all.indexOf(p) === i,
            )
            const failures = await probeModules(server, targets)
            logLine(`probe ${targets.length} module(s) → ${failures.length} failure(s)`)
            return sendJson(res, 200, { failures })
          }

          if (url === '/api/health/typecheck' && req.method === 'GET') {
            const diagnostics = await runTypecheck(root)
            logLine(`typecheck → ${diagnostics.length} diagnostic(s)`)
            return sendJson(res, 200, { diagnostics })
          }

          if (url === '/api/git/commit' && req.method === 'POST') {
            const { message } = JSON.parse(await readBody(req))
            const raw = typeof message === 'string' ? message.trim() : ''
            // Use the prompt text as the commit subject; git handles multi-line
            // messages and leading dashes fine since it's passed as an arg.
            const commitMsg = raw.length > 0 ? raw : 'agent turn'
            const hash = await gitCommitAll(root, commitMsg)
            const subject = commitMsg.split('\n')[0]
            logLine(
              hash
                ? `commit ${hash} "${subject.slice(0, 60)}"`
                : 'commit skipped (no changes this turn)',
            )
            return sendJson(res, 200, { committed: hash })
          }

          if (url === '/api/git/log' && req.method === 'GET') {
            try {
              const { stdout } = await execFileAsync(
                'git',
                // \x1f separates fields, \x1e separates commits — safe against
                // messages containing tabs or newlines. %B = full raw message.
                ['log', '-n', '200', '--pretty=format:%h%x1f%ae%x1f%ct%x1f%B%x1e'],
                { cwd: root },
              )
              const commits = stdout
                .split('\x1e')
                .map((rec) => rec.replace(/^\s+/, ''))
                .filter((rec) => rec.length > 0)
                .map((rec) => {
                  const [hash, email, ct, rawMessage = ''] = rec.split('\x1f')
                  const message = rawMessage.trim()
                  return {
                    hash,
                    date: Number(ct),
                    message,
                    kind:
                      message === SNAPSHOT_MESSAGE
                        ? 'snapshot'
                        : email === AGENT_AUTHOR_EMAIL
                          ? 'agent'
                          : 'user',
                  }
                })
              return sendJson(res, 200, { commits })
            } catch (err) {
              logLine(`git log failed: ${err}`)
              return sendJson(res, 500, { error: `git log failed: ${err}` })
            }
          }

          if (url === '/api/git/restore' && req.method === 'POST') {
            const { hash } = JSON.parse(await readBody(req))
            if (typeof hash !== 'string' || !/^[0-9a-f]{4,40}$/i.test(hash)) {
              return sendJson(res, 400, { error: 'hash must be a (abbreviated) commit hash' })
            }
            try {
              await execFileAsync('git', ['rev-parse', '--verify', `${hash}^{commit}`], {
                cwd: root,
              })
            } catch {
              logLine(`restore ${hash} → unknown commit`)
              return sendJson(res, 404, { error: `Unknown commit: ${hash}` })
            }
            try {
              // Preserve any uncommitted changes as a snapshot first so the
              // restore never destroys work.
              await gitCommitAll(root, SNAPSHOT_MESSAGE)
              const treeOf = async (ref: string) =>
                (await execFileAsync('git', ['rev-parse', `${ref}^{tree}`], { cwd: root })).stdout
                  .trim()
              if ((await treeOf('HEAD')) === (await treeOf(hash))) {
                logLine(`restore ${hash} → skipped (project already matches this state)`)
                return sendJson(res, 200, { ok: true, restored: null })
              }
              // Make index + working tree match the target commit (including
              // file deletions), then commit that state on top — unlike
              // /api/git/forget this never rewrites history.
              await execFileAsync('git', ['read-tree', '--reset', '-u', hash], { cwd: root })
              const restored = await gitCommitAll(root, `restore project state of ${hash}`)
              logLine(`restore ${hash} → committed as ${restored}`)
              return sendJson(res, 200, { ok: true, restored })
            } catch (err) {
              logLine(`restore failed: ${err}`)
              return sendJson(res, 500, { error: `git restore failed: ${err}` })
            }
          }

          if (url === '/api/git/rollback' && req.method === 'POST') {
            const { turnId } = JSON.parse(await readBody(req))
            if (!lastSnapshot || lastSnapshot.turnId !== turnId) {
              logLine(`rollback ${turnId} → no snapshot for this turn`)
              return sendJson(res, 409, {
                error: 'No snapshot exists for this turn — nothing to roll back.',
              })
            }
            try {
              // Keep the broken state in history first, so nothing is ever lost.
              await gitCommitAll(root, SNAPSHOT_MESSAGE)
              await execFileAsync('git', ['read-tree', '--reset', '-u', lastSnapshot.hash], {
                cwd: root,
              })
              const restored = await gitCommitAll(
                root,
                `rollback of broken agent changes (state of ${lastSnapshot.hash})`,
              )
              // The rollback removed the failed turn's manifests; reconciling
              // now stops exactly the services that turn started.
              const plan = await supervisor?.reconcile()
              if (plan && (plan.toStop.length > 0 || plan.toStart.length > 0)) {
                logLine(
                  `rollback reconcile → stopped ${plan.toStop.join(', ') || 'none'}` +
                    `, started ${plan.toStart.join(', ') || 'none'}`,
                )
              }
              logLine(`rollback ${turnId} → ${restored ?? 'nothing to do'}`)
              return sendJson(res, 200, { ok: true, snapshot: lastSnapshot.hash, restored })
            } catch (err) {
              logLine(`rollback failed: ${err}`)
              return sendJson(res, 500, { error: `git rollback failed: ${err}` })
            }
          }

          if (url === '/api/git/forget' && req.method === 'POST') {
            const { hash } = JSON.parse(await readBody(req))
            try {
              const { stdout: headRaw } = await execFileAsync(
                'git',
                ['rev-parse', '--short', 'HEAD'],
                { cwd: root },
              )
              const head = headRaw.trim()
              if (typeof hash !== 'string' || hash !== head) {
                logLine(`forget ${hash} → DENIED (only the newest commit can be removed)`)
                return sendJson(res, 409, {
                  error: `Only the newest commit (${head}) can be removed from history.`,
                })
              }
              const { stdout: status } = await execFileAsync('git', ['status', '--porcelain'], {
                cwd: root,
              })
              if (status.trim().length > 0) {
                logLine(`forget ${hash} → DENIED (working tree has uncommitted changes)`)
                return sendJson(res, 409, {
                  error:
                    'The working tree has uncommitted changes that would be lost. Commit or discard them first.',
                })
              }
              try {
                await execFileAsync('git', ['rev-parse', '--verify', 'HEAD^'], { cwd: root })
              } catch {
                return sendJson(res, 409, { error: 'Cannot remove the initial commit.' })
              }
              await execFileAsync('git', ['reset', '--hard', 'HEAD~1'], { cwd: root })
              logLine(`forget ${hash} → removed (git reset --hard HEAD~1)`)
              return sendJson(res, 200, { ok: true })
            } catch (err) {
              logLine(`forget failed: ${err}`)
              return sendJson(res, 500, { error: `git reset failed: ${err}` })
            }
          }

          logLine(`unknown route ${req.method} ${url} → 404`)
          return sendJson(res, 404, { error: `Unknown API route: ${req.method} ${url}` })
        }

        handle().catch((err) => {
          console.error('[agent] middleware error:', err)
          if (!res.headersSent) sendJson(res, 500, { error: String(err) })
          else res.end()
        })
      })
    },
  }
}
