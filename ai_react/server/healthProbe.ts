// Asks Vite to transform modules exactly the way it would for the browser. A
// throw here means the browser could not have loaded the module either:
// syntax error, unresolvable import, or missing file.
//
// Why not probe from the browser: over HTTP a broken module is a bare 500 with
// an empty body, and a MISSING file returns 200 text/html (the SPA fallback),
// which would look perfectly healthy. Only the server sees the real error.

import type { ViteDevServer } from 'vite'

// Vite colours its error messages. Those escape sequences would otherwise end
// up in the model's prompt. Built from the char code so the source file stays
// free of raw control characters.
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g')

export interface ProbeFailure {
  path: string
  message: string
}

export async function probeModules(
  server: ViteDevServer,
  paths: string[],
): Promise<ProbeFailure[]> {
  const env = server.environments.client
  const failures: ProbeFailure[] = []

  for (const rel of paths) {
    const url = '/' + rel.replace(/^\/+/, '')
    try {
      // Invalidate first: the write may have landed before Vite's watcher fired,
      // and a cached result would report a broken file as healthy.
      const mod = await env.moduleGraph.getModuleByUrl(url)
      if (mod) env.moduleGraph.invalidateModule(mod)
      await env.transformRequest(url)
    } catch (err) {
      const message = String((err as Error)?.message ?? err)
        .replace(ANSI, '')
        .replace(/\s+/g, ' ')
        .trim()
      failures.push({ path: rel, message: message.slice(0, 400) })
    }
  }

  return failures
}
