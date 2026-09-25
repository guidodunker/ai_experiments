// Turns supervisor status into health-check problems. Pure — no fetch in here,
// which is what makes the classification rules unit-testable.
//
// ServiceStatus deliberately mirrors the shape returned by /api/services
// (server/services/supervisor.ts) rather than importing it: browser and server
// code are separate tsconfig projects. Keep the two in sync when either moves.

import type { Problem } from './healthReport.ts'

export interface ServiceStatus {
  name: string
  kind: 'process' | 'container'
  state: 'stopped' | 'starting' | 'ready' | 'crashed'
  port: number
  enabled: boolean
  exitCode?: number | null
  lastLogs?: string
}

export function problemsFromServices(services: ServiceStatus[]): Problem[] {
  const problems: Problem[] = []
  for (const s of services) {
    // Disabled means the user stopped it by hand; restarting it would fight them.
    if (!s.enabled || s.state === 'ready') continue
    // A container that will not come up is an environment problem, not bad code.
    const kind = s.kind === 'container' ? 'infra' : 'service'
    const detail = s.lastLogs ? `\n${s.lastLogs}` : ''
    if (s.state === 'crashed') {
      problems.push({
        kind,
        file: `services/${s.name}`,
        message: `Service "${s.name}" crashed with exit code ${s.exitCode ?? 'unknown'}.${detail}`,
      })
    } else if (s.state === 'starting') {
      problems.push({
        kind,
        file: `services/${s.name}`,
        message: `Service "${s.name}" did not become ready within its health timeout.${detail}`,
      })
    } else {
      problems.push({
        kind,
        file: `services/${s.name}`,
        message: `Service "${s.name}" is declared and enabled but not running.`,
      })
    }
  }
  return problems
}
