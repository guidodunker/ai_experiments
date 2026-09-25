// Tool schemas (OpenAI function-calling format) and their client-side
// executors, which call the dev server's /api/fs endpoints.

export const toolSchemas = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description:
        'List all files and directories in the project (paths relative to the project root). Use this first to orient yourself.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file from the project. Returns the full file content.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Project-relative path, e.g. "src/App.tsx"',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Create or overwrite a text file in the project with the given content. Parent directories are created automatically. Always write the COMPLETE file content. The agent runtime (src/agent, src/chat, server, config files) is read-only.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Project-relative path, e.g. "src/components/NewThing.tsx"',
          },
          content: { type: 'string', description: 'Complete new file content' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description:
        'Delete a file from the project. The agent runtime is protected and cannot be deleted. Use remove_service to delete a whole service.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Project-relative path' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_service',
      description:
        'Declare a new backend service that runs as its own Node process next to the dev server. The server assigns the port and returns the URL the browser must use. Write the service source with write_file afterwards, then start it with control_service.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '3-32 chars, lowercase letters, digits and dashes, e.g. "notes-api"',
          },
          kind: {
            type: 'string',
            enum: ['process'],
            description: 'Only "process" in this version',
          },
          entry: {
            type: 'string',
            description: 'Entry file name inside the service directory, e.g. "index.ts"',
          },
          env: {
            type: 'object',
            description:
              'Optional UPPER_SNAKE_CASE environment variables. PORT is set for you.',
            additionalProperties: { type: 'string' },
          },
          health: {
            type: 'object',
            description: 'Optional readiness probe; defaults to GET /health with a 10s timeout.',
            properties: { path: { type: 'string' }, timeoutMs: { type: 'number' } },
          },
        },
        required: ['name', 'kind', 'entry'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'control_service',
      description:
        'Start, stop or restart a declared service. Starting waits until the health path answers, so a successful result means the service is really up.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          action: { type: 'string', enum: ['start', 'stop', 'restart'] },
        },
        required: ['name', 'action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_service',
      description: 'Stop a service and delete its manifest and directory.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'service_status',
      description: 'List every declared service with its state, port and browser URL.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'service_logs',
      description:
        "Read the tail of a service's stdout/stderr — the first thing to check when it crashed.",
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          lines: { type: 'number', description: 'How many lines (default 50, max 200)' },
        },
        required: ['name'],
      },
    },
  },
]

export interface ToolExecution {
  result: string
  isError: boolean
}

async function api(url: string, init?: RequestInit): Promise<ToolExecution> {
  const res = await fetch(url, init)
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
  if (!res.ok) {
    return { result: String(body.error ?? `HTTP ${res.status}`), isError: true }
  }
  return { result: JSON.stringify(body), isError: false }
}

export async function executeTool(
  name: string,
  argsJson: string,
  turnId: string,
): Promise<ToolExecution> {
  let args: Record<string, unknown> = {}
  if (argsJson.trim().length > 0) {
    try {
      args = JSON.parse(argsJson)
    } catch {
      return { result: `Invalid JSON in tool arguments: ${argsJson}`, isError: true }
    }
  }

  switch (name) {
    case 'list_files': {
      const res = await fetch('/api/fs/list')
      const body = await res.json()
      if (!res.ok) return { result: String(body.error), isError: true }
      const lines = (body.entries as { path: string; type: string }[]).map((e) =>
        e.type === 'dir' ? `${e.path}/` : e.path,
      )
      return { result: lines.join('\n'), isError: false }
    }
    case 'read_file': {
      const exec = await api('/api/fs/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: args.path }),
      })
      if (exec.isError) return exec
      return { result: (JSON.parse(exec.result) as { content: string }).content, isError: false }
    }
    case 'write_file': {
      const exec = await api('/api/fs/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: args.path, content: args.content, turnId }),
      })
      if (exec.isError) return exec
      const body = JSON.parse(exec.result) as { snapshot: string | null }
      return {
        result: body.snapshot
          ? `File written. (Git snapshot ${body.snapshot} was taken before this turn's first write.)`
          : 'File written.',
        isError: false,
      }
    }
    case 'delete_file': {
      const exec = await api('/api/fs/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: args.path, turnId }),
      })
      if (exec.isError) return exec
      return { result: 'File deleted.', isError: false }
    }
    case 'create_service': {
      const exec = await api('/api/services/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      })
      if (exec.isError) return exec
      const body = JSON.parse(exec.result) as {
        manifest: { name: string; port: number; entry: string }
        url: string
      }
      return {
        result:
          `Service "${body.manifest.name}" declared on port ${body.manifest.port}. ` +
          `Write its code to services/${body.manifest.name}/${body.manifest.entry} (it must ` +
          `listen on Number(process.env.PORT)), then call control_service to start it. ` +
          `The browser reaches it at ${body.url}.`,
        isError: false,
      }
    }
    case 'control_service': {
      const exec = await api('/api/services/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: args.name, action: args.action }),
      })
      if (exec.isError) return exec
      const { status } = JSON.parse(exec.result) as { status: { state: string; port: number } }
      return {
        result: `Service "${String(args.name)}" is now ${status.state} (port ${status.port}).`,
        isError: false,
      }
    }
    case 'remove_service': {
      const exec = await api('/api/services/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: args.name }),
      })
      if (exec.isError) return exec
      return { result: `Service "${String(args.name)}" removed.`, isError: false }
    }
    case 'service_status': {
      const res = await fetch('/api/services')
      const body = await res.json()
      if (!res.ok) return { result: String(body.error), isError: true }
      const services = body.services as {
        name: string
        state: string
        port: number
        enabled: boolean
        url: string
      }[]
      if (services.length === 0) return { result: 'No services declared.', isError: false }
      return {
        result: services
          .map(
            (s) =>
              `${s.name}: ${s.state}${s.enabled ? '' : ' (disabled)'} · port ${s.port} · ${s.url}`,
          )
          .join('\n'),
        isError: false,
      }
    }
    case 'service_logs': {
      const exec = await api('/api/services/logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: args.name, lines: args.lines }),
      })
      if (exec.isError) return exec
      const { logs } = JSON.parse(exec.result) as { logs: string }
      return { result: logs.length > 0 ? logs : '(no output)', isError: false }
    }
    default:
      return { result: `Unknown tool: ${name}`, isError: true }
  }
}
