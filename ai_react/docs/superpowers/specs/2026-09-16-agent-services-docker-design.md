# Agent-managed services and containers — Design

**Status: approved on 2026-09-16.** Next step: `writing-plans` for the implementation
plan. Nothing here is implemented yet.

Goal: the internal coding agent can build a *full-stack* feature end to end — write a
backend service, start the database container it needs, and wire the React frontend to
both — instead of being limited to files that run inside the browser.

## Decisions (brainstorming 2026-09-16)

| Question | Decision |
|---|---|
| Target capability | Full-stack feature: services and containers are two halves of one capability, not separate features. |
| Autonomy | Own services: fully autonomous. Containers: only from a curated catalog with pinned images; anything outside it is refused. |
| State model | Declared in git. Each service is a committed manifest; the supervisor reconciles reality to what is declared. Named volumes are never deleted by reconcile or rollback. |
| Service dependencies | The agent may run `npm install` through a dedicated tool. Hardened (`--ignore-scripts`, `--save-exact`, name validation), but the supply-chain risk is accepted, not solved. |
| Health gate | A process service that will not start or dies during the turn counts as *broken*: 3 repair attempts, then rollback. Container/infrastructure failures are reported and repaired but never trigger a rollback. |
| UI | A collapsible "Services" panel in the chat: state, port, uptime, log tail, and manual start/stop/restart buttons. |
| Engine | One supervisor with one `Runnable` interface implemented twice (process, container). Explicitly **not** Docker Compose — see §13. |

## Verified assumptions

Measured on this machine on 2026-09-16, not assumed:

- **Docker 29.7.2**, Compose v5.5.0, daemon running (`OSType=linux`). Compose is available
  but deliberately unused (§13).
- **Node v22.14.0** — `--permission` is available (still flagged experimental upstream);
  `--experimental-strip-types` is already used by `npm test`, so TS services need no build
  step.
- **`services/` is already writable today.** The sandbox is allow-by-default: only
  `WRITE_PROTECTED_DIRS` = `server`, `src/agent`, `src/chat`, `tests` plus the config file
  list are refused (`server/agentPlugin.ts:28`). Only *deleting* and *running* are missing.
- **`gitCommitAll` uses `git add -A`** (`server/agentPlugin.ts:109`), so manifests,
  deletions, `package.json` and the lockfile are already covered by the turn snapshot and
  by `git read-tree` rollback. No change needed to the snapshot mechanism.
- **`checkSyntax` already handles `.ts`**, so service source files get the same write-time
  syntax gate as component files, for free.

**Spike resolved on 2026-09-16 — the permission model holds.** Measured with a real
service under
`node --permission --allow-fs-read=<dir> --allow-fs-write=<dir> --allow-fs-read=<root>/node_modules --experimental-strip-types index.ts`:

| Capability | Result |
|---|---|
| `import ts from "typescript"` (from root `node_modules`) | works |
| `http.createServer` + `fetch` | works |
| Write inside its own directory | allowed |
| Read `../../package.json` | **blocked** (`ERR_ACCESS_DENIED`) |
| Read `../../.env` | **blocked** (`ERR_ACCESS_DENIED`) |
| `child_process.execSync` | **blocked** (`ERR_ACCESS_DENIED`) |

Two corrections this produced: **`--allow-net` does not exist in Node 22** (the permission
model does not gate the network there; passing it is a fatal `bad option` error), and each
service directory needs its own `package.json` containing `{"type":"module"}` or Node warns
and reparses every file. The fallback in §9 is therefore not needed.

## 1. Architecture overview

```mermaid
flowchart TD
    Browser["Browser: React app + chat UI"]
    Panel["ServicesPanel (src/chat)"]
    Loop["Agent loop (src/agent)"]
    Routes["/api/services/* + /svc/:name (server/services/routes.ts)"]
    Sup["Supervisor (registry · reconcile · readiness)"]
    Proc["ProcessRunnable → node --experimental-strip-types"]
    Cont["ContainerRunnable → docker CLI"]
    Man["services/*/service.json (git)"]

    Browser -->|"fetch /svc/notes-api/..."| Routes
    Panel -->|status · logs · start/stop| Routes
    Loop -->|tool calls| Routes
    Routes --> Sup
    Sup --> Proc
    Sup --> Cont
    Man -->|desired state| Sup
    Sup -->|writes on create/remove| Man
```

New modules, each with one responsibility. `server/agentPlugin.ts` is already 460 lines
and gets only a two-line wiring change — the service routes live in their own module:

| File | Responsibility |
|---|---|
| `server/services/manifest.ts` | Manifest schema, validation, load/save, name rules |
| `server/services/catalog.ts` | The curated image catalog (read-only data) |
| `server/services/ports.ts` | Port-pool allocation with real bind checks |
| `server/services/processRunnable.ts` | Spawn/kill Node processes, log ring buffer |
| `server/services/containerRunnable.ts` | `docker` CLI wrapper |
| `server/services/supervisor.ts` | Registry, lifecycle, readiness, reconciliation |
| `server/services/routes.ts` | `/api/services/*` HTTP layer and the `/svc/:name` proxy |
| `src/chat/ServicesPanel.tsx` | The UI panel |

All of these live in `server/` and `src/chat/`, which are already write-protected — the
agent can read its new machinery for context but cannot modify it.

## 2. Manifests and the catalog

**Manifests are server-owned.** `services/<name>/service.json` is created only through a
validated tool, never through `write_file`: the path pattern `services/*/service.json`
joins the write-protected list. The agent writes service *source code*; the server owns
names, ports, images, volumes and env. This makes catalog enforcement authoritative rather
than advisory, and keeps port allocation out of the model's hands.

```json
{
  "name": "notes-api",
  "kind": "process",
  "entry": "index.ts",
  "port": 4001,
  "env": { "DATABASE_URL": "postgres://postgres:app@127.0.0.1:5433/postgres" },
  "enabled": true,
  "health": { "path": "/health", "timeoutMs": 10000 }
}
```

```json
{
  "name": "notes-db",
  "kind": "container",
  "image": "postgres",
  "port": 5433,
  "env": { "POSTGRES_PASSWORD": "app" },
  "volume": "notes-db-data"
}
```

- `name` must match `^[a-z][a-z0-9-]{2,31}$` and equal the directory name.
- `image` is a **catalog key, not an image reference**. An unknown key is refused with the
  list of available keys, so the model can correct itself in the next iteration.
- `env` keys are filtered against the catalog's allowlist for containers; unknown keys are
  dropped and reported in the tool result rather than silently ignored.
- `port` is always the **host** port and is always assigned by the allocator.
- `enabled` records whether the service *should* be running. `control_service stop` sets it
  to `false`, `start` sets it back to `true`. Reconciliation starts only enabled services
  and the health gate ignores disabled ones — without this, a service you stopped by hand
  would be reported as broken and restarted by the agent on the next turn.

The catalog (`server/services/catalog.ts`) maps each key to a pinned image, its container
port, allowed and default env keys, the data path to mount as a named volume, and a
readiness probe. Starter set: `postgres`, `elasticsearch`, `redis`. Adding an entry is a
deliberate human edit to a write-protected file.

```ts
postgres: {
  image: 'postgres:17-alpine',
  containerPort: 5432,
  volumePath: '/var/lib/postgresql/data',
  envAllow: ['POSTGRES_PASSWORD', 'POSTGRES_USER', 'POSTGRES_DB'],
  envDefaults: { POSTGRES_PASSWORD: 'app', POSTGRES_USER: 'postgres', POSTGRES_DB: 'app' },
  ready: { type: 'exec', cmd: ['pg_isready', '-U', 'postgres'], timeoutMs: 60000 },
  // `env` is the manifest env after defaults have been merged in.
  connection: (m, env) =>
    `postgres://${env.POSTGRES_USER}:${env.POSTGRES_PASSWORD}@127.0.0.1:${m.port}/${env.POSTGRES_DB}`,
}
```

## 3. Tool surface

Three tools today become ten, so each one earns its place. Start/stop/restart are folded
into a single `control_service` deliberately: every tool schema is re-sent on every model
call, and more near-identical tools means more wrong tool choices, each costing a full
loop iteration.

| Tool | Milestone | Arguments | Returns |
|---|---|---|---|
| `create_service` | M1 (process) / M2 (container) | `name`, `kind`, `entry?`, `image?`, `env?`, `health?` | Assigned port, `/svc/<name>` URL, and for containers the server-generated connection string |
| `control_service` | M1 | `name`, `action: start\|stop\|restart` | State + readiness time, or exit code and log tail on failure |
| `remove_service` | M1 | `name` | Stops it, deletes manifest and service directory; keeps the named volume |
| `service_status` | M1 | — | All services: kind, state, port, uptime, last exit code |
| `service_logs` | M1 | `name`, `lines?` (default 50) | Tail of the ring buffer / `docker logs --tail` |
| `delete_file` | M1 | `path` | Confirmation; same sandbox and write-protection checks as `write_file` |
| `install_package` | M2 | `name`, `dev?` | npm summary, or stderr tail on failure |

`create_service` returning the connection string matters: the agent must never invent
credentials, ports or URLs — it receives them from the component that owns them.

## 4. Supervisor and reconciliation

The supervisor holds a registry keyed by service name, and talks to both runtimes through
one interface:

```ts
interface Runnable {
  start(m: Manifest): Promise<void>
  stop(m: Manifest): Promise<void>
  status(m: Manifest): Promise<RunState>   // 'stopped'|'starting'|'ready'|'crashed'
  logs(m: Manifest, lines: number): Promise<string>
}
```

This interface is not ceremony: it is what makes reconciliation testable with a fake
runnable, without Docker or spawned processes (§11).

**Reconciliation** runs on dev-server boot, after every turn, and after a rollback:

1. Desired state = every `services/*/service.json` on disk.
2. Actual state = the in-memory process map + `docker ps --filter label=ai-react.service`.
3. Start what is declared but not running; stop and remove what is running but no longer
   declared; adopt what matches.

Every container the agent creates carries `--label ai-react.service=<name>`, so orphan
cleanup provably cannot touch containers you started yourself. Named volumes are never
removed by reconcile — only by an explicit user action in the panel.

**Process spawn:** `node --permission --allow-fs-read=<dir> --allow-fs-read=./node_modules
--allow-fs-write=<dir> --allow-net --experimental-strip-types index.ts`, `cwd` pinned to
the service directory, `stdio: 'pipe'`, `windowsHide: true`, env restricted to the manifest
plus `PORT`. Kill uses `taskkill /PID <pid> /T /F` on Windows — `child.kill()` leaves the
process tree alive — and `SIGTERM`, then `SIGKILL` after 5 s, elsewhere.

**No auto-restart on crash.** A crashed service must stay visible to the health gate
instead of being papered over by a restart loop. The supervisor records exit code, exit
time, and the last log lines.

**Readiness** is polled, not assumed: `GET http://127.0.0.1:<port><health.path>` until 200
or `timeoutMs` (default 10 s) for processes; the catalog probe until timeout (default 60 s)
for containers, because Elasticsearch is slow to boot. A service is only reported as
started once it is ready.

Log ring buffer: the last 200 lines of stdout+stderr per process service, so a crash
report can carry context without unbounded memory growth.

## 5. Networking

- **Port pools:** 4001–4099 for processes, 5401–5499 for containers. The allocator
  confirms each candidate with a real bind attempt before assigning it, so a port used by
  something outside this project is skipped rather than colliding at start time. Pool
  exhaustion is an explicit error.
- **The browser only ever talks to process services.** `/svc/<name>/*` is proxied by the
  plugin middleware to `127.0.0.1:<port>/*`. Components use relative URLs, there is no
  CORS, and no port number ever appears in component code — so a reassigned port cannot
  break the UI.
- **Containers are not proxied** and are bound with `-p 127.0.0.1:<host>:<container>`, so a
  database is reachable from services on this machine and from nowhere else.

## 6. Health gate and rollback

`verifyApp` (`src/agent/verify.ts`) gains a fourth source, run **first** because it is a
cheap in-memory read of supervisor state, consistent with the existing cheapest-first
ordering:

| New `Problem` kind | Cause | Consequence |
|---|---|---|
| `service` | Declared but not running · never became ready · exited during the turn | `isAppBroken()` → true: 3 repair attempts, then rollback |
| `infra` | Container will not pull · never turns healthy · Docker daemon down | Reported and repairable, never rollback-eligible — the same treatment type errors get today |

A `service` problem message carries the exit code and the last 10 log lines, because that
is what the model needs in order to repair it.

**Rollback gains a reconcile step.** `/api/git/rollback` calls `supervisor.reconcile()`
after `git read-tree` and before responding. Without this, a rolled-back turn would restore
the files but leave its services running against deleted code — the correctness gap that
motivated this part of the design. Because the manifests are gone after the rollback,
reconcile stops and removes exactly the services the failed turn created. Named volumes
survive.

## 7. Lifecycle rules

**Containers persist across dev-server restarts; processes do not.** Processes are children
of the dev server and are killed on shutdown (`httpServer` close / `buildEnd`) so nothing
is orphaned; reconcile restarts them from their manifests on the next boot. Containers stay
detached and are adopted by label, because re-pulling and re-booting Elasticsearch on every
`npm run dev` would be miserable.

## 8. UI: the services panel

`src/chat/ServicesPanel.tsx`, collapsible, rendered inside the chat subtree so it survives
an `App.tsx` crash through the existing `AppErrorBoundary`.

- One row per service: name, kind badge, state dot (`stopped` · `starting` · `ready` ·
  `crashed`), host port, uptime, last exit code if crashed.
- Buttons: start, stop, restart, and show logs (expands a `<pre>` with the tail).
- Polls `/api/services/status` every 3 s while expanded, plus once after each turn ends.
  Collapsed, it shows a one-line summary ("3 running · 1 unhealthy") and does not poll.
- When Docker is unavailable, container rows render disabled with "Docker unavailable"
  rather than as errors.

## 9. Safety model and its limits

Today's containment is entirely path-based, and it holds only because agent output never
executes outside the browser and Vite's module graph. Spawning a process breaks that
premise: a service runs as the user, with the user's privileges. This section is the
honest accounting.

**Process containment.** `cwd` is not a jail — without further measures a service could
write `../../server/agentPlugin.ts` or read `.env`, walking through every check in
`agentPlugin.ts`. The mitigation is Node's permission model, which also blocks
`child_process`, worker threads and native addons. It is on by default, configured by a
server-side constant the agent cannot edit. Its viability is the spike named above; if it
fails, the fallback is documented reduced containment, not a silent downgrade.

**`install_package` deliberately bypasses the `package.json` write protection.** That is
the accepted consequence of the dependency decision. Hardening: `--ignore-scripts` by
default (this closes the `postinstall` remote-code-execution path, the main npm attack
vector), `--save-exact`, package names validated against `^[@a-z0-9][\w.@/-]*$`, no flag
pass-through, every install logged to the dev-server console. What remains is inherent and
is not solved: arbitrary registry code that a service later imports and executes.

**Docker.** Catalog keys only, pinned tags, loopback-only port binding, label-scoped
cleanup, no `--privileged`, no bind mounts of the project into containers (named volumes
only), no `docker exec` exposed as a tool. Every CLI call goes through `execFile` with an
argument array — no shell, no interpolation.

**Unchanged:** `server/`, `src/agent/`, `src/chat/`, `tests/` and the config files stay
write-protected; `.env` and `package-lock.json` stay invisible to the agent's file tools;
`services/*/service.json` joins the protected list.

This is a dev-machine tool. The design raises the cost of an accident substantially, and it
does not make a determined adversarial model harmless.

## 10. Failure modes

| Situation | Behaviour |
|---|---|
| Docker missing or daemon down | Container tools return a clear error; the panel shows "Docker unavailable"; the dev server never crashes; process services keep working |
| Port collision | Allocator verifies with a real bind before assigning; exhaustion is an explicit error |
| First image pull is slow | Start blocks through the pull, progress goes to the dev-server console, and the tool result reports `pulled 340 MB in 47s` so the model does not retry a working pull |
| Service crashes at start | Tool result carries exit code + log tail; the agent repairs it inside the turn, before the health gate runs |
| Service crashes after the turn | Caught by the next status poll and by the existing watchdog path |
| Name collision | Refused, with the list of existing names |
| `npm install` fails | stderr tail returned as the tool result |
| Manifest on disk is invalid (hand-edited) | Reconcile skips it and logs a warning; it never crashes the dev server |

## 11. Testing

Follows the existing pattern: `node --experimental-strip-types --test` over pure functions
in the write-protected `tests/` directory. The `Runnable` interface exists partly so the
interesting logic is testable without spawning anything.

- `manifest.test.ts` — validation, name rules, catalog key resolution, env allowlist
  filtering, rejection message content
- `ports.test.ts` — allocation, collision avoidance, pool exhaustion
- `supervisor.test.ts` — reconcile diffing against a fake runnable: starts missing, stops
  orphans, adopts matching, never touches unlabelled containers
- `serviceHealth.test.ts` — supervisor state → `Problem[]`, and the `service` → broken /
  `infra` → not-broken classification

Docker- and spawn-dependent integration checks go into a separate `npm run test:services`,
kept out of `npm test` so the default suite stays green without a daemon.

Manual scenarios for acceptance are listed per milestone below.

## 12. Milestones

**M1 — processes end to end.** Spike on `--permission` first. Then: `delete_file`, manifest
+ ports + `ProcessRunnable`, supervisor with reconcile, routes + `/svc` proxy, the four
process tools, system-prompt update, the `service` problem kind, rollback → reconcile, and
the services panel (process rows only).

*Acceptance:* the agent builds an API service plus a page that calls it; a deliberately
crashing service is repaired inside the same turn; a turn that stays broken is rolled back
**and** its service is stopped; restarting the dev server brings declared services back.

**M2 — containers.** Catalog, `ContainerRunnable`, readiness probes, named volumes, label
adoption, the `infra` problem kind, `install_package`, container rows in the panel.

*Acceptance:* "build a notes page backed by Postgres" works from a single prompt; stopping
Docker mid-session degrades gracefully; a rollback removes the container but keeps the
volume.

## 13. Out of scope (YAGNI)

- **Docker Compose as the engine.** It would give dependency ordering, healthchecks and
  networks for free, but it fights two decisions above: a curated catalog is hard to
  enforce against free-form YAML the agent writes, and running our own services in
  containers makes iteration slow on Windows bind mounts and pushes debugging one layer
  away. Revisit if multi-service stacks with real startup ordering become common.
- **A dependency graph between services.** Nothing stops the agent from stopping a database
  another service uses; the resulting errors surface through the normal browser error
  stream. Add ordering only when a real case demands it.
- **Production concerns** — the agent remains dev-mode only; a production build still
  contains no agent backend and no supervisor.
- **Reverting `node_modules` on rollback.** A rolled-back turn restores `package.json` and
  the lockfile but leaves the package physically installed. Harmless, and it self-corrects
  on the next install.
