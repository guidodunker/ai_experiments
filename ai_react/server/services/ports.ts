// Host-port allocation. Every candidate is confirmed with a real bind attempt,
// so a port held by something outside this project is skipped instead of
// colliding later at start time.

import net from 'node:net'

export interface PortRange {
  from: number
  to: number
}

export const PROCESS_PORTS: PortRange = { from: 4001, to: 4099 }

export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, '127.0.0.1')
  })
}

/** Lowest free port in `range` that is not already claimed by a manifest. */
export async function allocatePort(
  taken: Iterable<number>,
  range: PortRange = PROCESS_PORTS,
): Promise<number> {
  const claimed = new Set(taken)
  for (let port = range.from; port <= range.to; port++) {
    if (claimed.has(port)) continue
    if (await isPortFree(port)) return port
  }
  throw new Error(
    `No free port in range ${range.from}-${range.to}. Remove an unused service and try again.`,
  )
}
