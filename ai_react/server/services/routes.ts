// The HTTP surface of the supervisor: /api/services/* for the agent and the
// panel, and /svc/<name>/* as a same-origin proxy so components never hardcode
// a port and never need CORS.

import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Supervisor } from './supervisor.ts'

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

/** Forward a browser request to the service's own HTTP server. */
async function proxy(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  supervisor: Supervisor,
): Promise<void> {
  const [, , name, ...rest] = url.split('/') // "" / "svc" / name / path…
  const manifest = await supervisor.find(name ?? '')
  if (!manifest) return sendJson(res, 404, { error: `Unknown service: ${name}` })
  const status = (await supervisor.status()).find((s) => s.name === name)
  if (status?.state !== 'ready') {
    return sendJson(res, 503, {
      error: `Service "${name}" is ${status?.state ?? 'stopped'} — start it before calling it.`,
    })
  }

  const rawUrl = req.url ?? ''
  const search = rawUrl.includes('?') ? `?${rawUrl.split('?')[1]}` : ''
  const upstream = http.request(
    {
      host: '127.0.0.1',
      port: manifest.port,
      method: req.method,
      path: `/${rest.join('/')}${search}`,
      headers: { ...req.headers, host: `127.0.0.1:${manifest.port}` },
    },
    (up) => {
      res.statusCode = up.statusCode ?? 502
      for (const [key, value] of Object.entries(up.headers)) {
        if (value !== undefined) res.setHeader(key, value)
      }
      up.pipe(res)
    },
  )
  upstream.on('error', (err) => {
    sendJson(res, 502, { error: `Service "${name}" is not reachable: ${err.message}` })
  })
  req.pipe(upstream)
}

/**
 * Handle a service request. Returns false when the URL is none of ours, so the
 * caller can fall through to the next middleware.
 */
export async function handleServiceRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  supervisor: Supervisor,
  log: (msg: string) => void,
): Promise<boolean> {
  if (url.startsWith('/svc/')) {
    await proxy(req, res, url, supervisor)
    return true
  }
  if (!url.startsWith('/api/services')) return false

  try {
    if (url === '/api/services' && req.method === 'GET') {
      sendJson(res, 200, { services: await supervisor.status() })
      return true
    }
    if (url === '/api/services/create' && req.method === 'POST') {
      const manifest = await supervisor.create(JSON.parse(await readBody(req)))
      log(`service create ${manifest.name} → port ${manifest.port}`)
      sendJson(res, 200, { manifest, url: `/svc/${manifest.name}` })
      return true
    }
    if (url === '/api/services/control' && req.method === 'POST') {
      const { name, action } = JSON.parse(await readBody(req))
      if (action !== 'start' && action !== 'stop' && action !== 'restart') {
        sendJson(res, 400, { error: 'action must be start, stop or restart' })
        return true
      }
      const status = await supervisor.control(String(name), action)
      log(`service ${action} ${String(name)} → ${status.state}`)
      sendJson(res, 200, { status })
      return true
    }
    if (url === '/api/services/remove' && req.method === 'POST') {
      const { name } = JSON.parse(await readBody(req))
      await supervisor.remove(String(name))
      log(`service remove ${String(name)}`)
      sendJson(res, 200, { ok: true })
      return true
    }
    if (url === '/api/services/logs' && req.method === 'POST') {
      const { name, lines } = JSON.parse(await readBody(req))
      const count = typeof lines === 'number' && lines > 0 && lines <= 200 ? lines : 50
      sendJson(res, 200, { logs: await supervisor.logs(String(name), count) })
      return true
    }
  } catch (err) {
    // Validation failures are the normal path for a model that guessed wrong:
    // report them as 400 with the message, so it can correct itself.
    log(`service request failed: ${String(err)}`)
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
    return true
  }

  sendJson(res, 404, { error: `Unknown service route: ${req.method} ${url}` })
  return true
}
