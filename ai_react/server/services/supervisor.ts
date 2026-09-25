// Owns the declared state (manifests on disk) and the actual state (running
// processes), and keeps them in sync. Reconciliation is what makes a git
// rollback effective: restoring the tree removes manifests, and the next
// reconcile stops whatever is no longer declared.

import fs from 'node:fs/promises'
import path from 'node:path'
import { allocatePort } from './ports.ts'
import {
  buildManifest,
  listManifests,
  saveManifest,
  serviceDir,
  validateName,
  type Manifest,
  type ManifestInput,
} from './manifest.ts'
import { createProcessRunnable, type RunInfo, type Runnable } from './processRunnable.ts'

export interface ReconcilePlan {
  toStart: string[]
  toStop: string[]
}

/** Pure set arithmetic — the part worth unit-testing. */
export function reconcilePlan(
  declared: { name: string; enabled: boolean }[],
  running: string[],
): ReconcilePlan {
  const wanted = declared.filter((d) => d.enabled).map((d) => d.name)
  const runningSet = new Set(running)
  return {
    toStart: wanted.filter((name) => !runningSet.has(name)),
    toStop: running.filter((name) => !wanted.includes(name)),
  }
}

export interface ServiceStatus extends RunInfo {
  name: string
  kind: Manifest['kind']
  port: number
  enabled: boolean
  url: string
}

export interface Supervisor {
  create(input: ManifestInput): Promise<Manifest>
  control(name: string, action: 'start' | 'stop' | 'restart'): Promise<ServiceStatus>
  remove(name: string): Promise<void>
  status(): Promise<ServiceStatus[]>
  logs(name: string, lines: number): Promise<string>
  reconcile(): Promise<ReconcilePlan>
  shutdown(): Promise<void>
  /** Manifest for `name`, or undefined — used by the /svc proxy. */
  find(name: string): Promise<Manifest | undefined>
}

export function createSupervisor(root: string): Supervisor {
  const runnable: Runnable = createProcessRunnable(root)

  async function manifestOf(name: string): Promise<Manifest> {
    const found = (await listManifests(root)).find((m) => m.name === validateName(name))
    if (!found) throw new Error(`Unknown service "${name}".`)
    return found
  }

  async function statusOf(m: Manifest): Promise<ServiceStatus> {
    return {
      ...(await runnable.status(m)),
      name: m.name,
      kind: m.kind,
      port: m.port,
      enabled: m.enabled,
      url: `/svc/${m.name}`,
    }
  }

  return {
    async create(input) {
      const name = validateName(input.name)
      const existing = await listManifests(root)
      if (existing.some((m) => m.name === name)) {
        throw new Error(
          `A service named "${name}" already exists. Existing services: ` +
            `${existing.map((m) => m.name).join(', ')}.`,
        )
      }
      const port = await allocatePort(existing.map((m) => m.port))
      const manifest = buildManifest(input, port)
      await saveManifest(root, manifest)
      // Without this, Node warns about a typeless package and reparses every
      // file on every start (verified during the spike).
      await fs.writeFile(
        path.join(serviceDir(root, name), 'package.json'),
        JSON.stringify({ type: 'module' }, null, 2) + '\n',
        'utf-8',
      )
      return manifest
    },

    async control(name, action) {
      const m = await manifestOf(name)
      if (action === 'stop') {
        await runnable.stop(m)
        const disabled = { ...m, enabled: false }
        await saveManifest(root, disabled)
        return statusOf(disabled)
      }
      if (action === 'restart') await runnable.stop(m)
      const enabled = { ...m, enabled: true }
      await saveManifest(root, enabled)
      await runnable.start(enabled)
      return statusOf(enabled)
    },

    async remove(name) {
      const m = await manifestOf(name)
      await runnable.stop(m)
      await fs.rm(serviceDir(root, m.name), { recursive: true, force: true })
    },

    async status() {
      const manifests = await listManifests(root)
      return Promise.all(manifests.map(statusOf))
    },

    async logs(name, lines) {
      return runnable.logs(await manifestOf(name), lines)
    },

    async reconcile() {
      const manifests = await listManifests(root)
      const plan = reconcilePlan(manifests, await runnable.running())
      for (const name of plan.toStop) {
        const m = manifests.find((x) => x.name === name)
        // An orphan whose manifest is gone still needs killing: synthesise the
        // minimum the runnable needs to find it.
        await runnable.stop(m ?? ({ name, port: 0 } as Manifest))
      }
      for (const name of plan.toStart) {
        const m = manifests.find((x) => x.name === name)
        if (!m) continue
        try {
          await runnable.start(m)
        } catch (err) {
          console.warn(`[agent] service ${name} failed to start: ${String(err)}`)
        }
      }
      return plan
    },

    async shutdown() {
      await runnable.stopAll()
    },

    async find(name) {
      return (await listManifests(root)).find((m) => m.name === name)
    },
  }
}
