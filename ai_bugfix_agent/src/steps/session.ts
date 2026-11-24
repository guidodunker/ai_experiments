import { query, type HookCallback, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import { decide, describeCall, type Mode } from './policy.ts'

export type SessionRequest = {
  mode: Mode
  /** Der Worktree; die Sitzung arbeitet nur hier. */
  cwd: string
  /** Prompt des Schritts, wird an den System-Prompt von Claude Code angehängt. */
  instructions: string
  /** Ticket und Angaben zum Lauf */
  prompt: string
  /** JSON-Schema des Ergebnisses */
  schema: Record<string, unknown>
  maxTurns: number
}

export type SessionResult = { output: unknown; costUsd: number }

/** In Tests ein Fake, sonst `agentSdkSession`. */
export type RunSession = (request: SessionRequest) => Promise<SessionResult>

export type SessionConfig = {
  model: string
  maxBudgetUsd: number
  testCommand: string
  log: (message: string) => void
  /** Umgebung des Claude-Code-Prozesses: ohne Geheimnisse, ggf. mit OpenRouter-Zugang */
  env: Record<string, string | undefined>
}

const TOOLS: Record<Mode, string[]> = {
  analyze: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash'],
  plan: ['Read', 'Grep', 'Glob'],
  fix: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash'],
}

/** Der einzige Ort, der das Agent SDK anfasst. */
export function agentSdkSession(config: SessionConfig): RunSession {
  return async (request) => {
    // Greift bei jedem Tool-Aufruf. canUseTool würde lesende Tools nicht sehen.
    const guard: HookCallback = async (input) => {
      if (input.hook_event_name !== 'PreToolUse') return {}
      const toolInput = (input.tool_input ?? {}) as Record<string, unknown>
      const decision = decide(input.tool_name, toolInput, {
        mode: request.mode,
        worktree: request.cwd,
        testCommand: config.testCommand,
      })
      if (!decision.allow) config.log(`  abgelehnt: ${describeCall(input.tool_name, toolInput)}: ${decision.reason}`)
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: decision.allow ? 'allow' : 'deny',
          permissionDecisionReason: decision.allow ? undefined : decision.reason,
        },
      }
    }

    let result: SDKResultMessage | undefined
    for await (const message of query({
      prompt: request.prompt,
      options: {
        cwd: request.cwd,
        model: config.model,
        tools: TOOLS[request.mode],
        permissionMode: 'dontAsk',
        // Keine Nutzer- oder Projekteinstellungen, kein CLAUDE.md aus dem Ziel-Repo
        settingSources: [],
        systemPrompt: { type: 'preset', preset: 'claude_code', append: request.instructions },
        outputFormat: { type: 'json_schema', schema: request.schema },
        maxTurns: request.maxTurns,
        maxBudgetUsd: config.maxBudgetUsd,
        hooks: { PreToolUse: [{ hooks: [guard], onFailure: 'block' }] },
        env: config.env,
      },
    })) {
      if (message.type === 'result') result = message
    }

    if (result === undefined) throw new Error('Sitzung ohne Ergebnis beendet.')
    const cost = `${result.total_cost_usd.toFixed(2)} $`
    if (result.subtype !== 'success') throw new Error(`Sitzung abgebrochen: ${result.subtype} (${cost})`)
    if (result.structured_output === undefined) throw new Error(`Sitzung ohne strukturiertes Ergebnis (${cost})`)
    return { output: result.structured_output, costUsd: result.total_cost_usd }
  }
}
