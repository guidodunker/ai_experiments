import { OpenRouter, stepCountIs, type Tool } from '@openrouter/agent'
import { connectWeatherMcp } from './weather_mcp.ts'
import { getWeather } from './weather_tool.ts'

const USAGE = 'usage: npm start -- "<prompt>"'

/** The model to talk to. Any slug from https://openrouter.ai/models works.
 *  Must advertise BOTH `tools` and `structured_outputs` in its
 *  supported_parameters, or the schema below is silently ignored:
 *  nvidia/nemotron-3-ultra-550b-a55b:free  (tools only — no schema support)
 *  minimax/minimax-m3:free                 (tools only — no schema support)
 *  nvidia/nemotron-3-super-120b-a12b:free  (both)
 *  z-ai/glm-5.2:free                       (both)
 *  anthropic/claude-sonnet-5      $0.004082
 *  ~anthropic/claude-haiku-latest $0.001953
 **/
const MODEL = process.env.OPENROUTER_MODEL ?? '~anthropic/claude-haiku-latest'

/** Where weather comes from: `api` calls Open-Meteo directly via `getWeather`,
 *  `mcp` uses the tools of a remote Open-Meteo MCP server instead. */
const WEATHER_SOURCE = process.env.WEATHER_SOURCE ?? 'api'

/** Bound the agent loop so a confused model cannot bill an unbounded run. */
const MAX_STEPS = 6

/**
 * The shape the model must answer in. Every key is required so `strict` mode
 * accepts the schema, and the weather fields are nullable because a prompt that
 * is not about weather has no city or temperature to report.
 */
const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string', description: 'The answer to the prompt, in prose.' },
    city: { type: ['string', 'null'], description: 'Resolved city name, or null.' },
    temp: { type: ['number', 'null'], description: 'Temperature in °C, or null.' },
    condition: { type: ['string', 'null'], description: 'Sky conditions, or null.' },
    humidity: { type: ['number', 'null'], description: 'Relative humidity in %, or null.' },
    wind: { type: ['number', 'null'], description: 'Wind speed in km/h, or null.' },
    comment: { type: 'string', description: 'A short remark about the answer.' },
  },
  required: [], // 'answer', 'city', 'temp', 'condition', 'humidity', 'wind', 'comment'],
  additionalProperties: false,
} as const

type Answer = {
  answer: string
  city: string | null
  temp: number | null
  condition: string | null
  humidity: number | null
  wind: number | null
  comment: string
}

/**
 * Exit codes follow the convention that 2 means "you invoked it wrong, no
 * request was made" and 1 means "the request was made and it failed", so a
 * shell script can tell the two apart.
 */
async function main(): Promise<number> {
  const prompt = process.argv[2]
  if (prompt === undefined || prompt.trim() === '') {
    process.stderr.write(`${USAGE}\n`)
    return 2
  }

  const apiKey = process.env.OPENROUTER_API_KEY
  if (apiKey === undefined || apiKey.trim() === '') {
    process.stderr.write(
      'OPENROUTER_API_KEY is not set.\n' +
        'Add OPENROUTER_API_KEY=<key> to .env, using a key from\n' +
        'https://openrouter.ai/keys\n',
    )
    return 2
  }

  if (WEATHER_SOURCE !== 'api' && WEATHER_SOURCE !== 'mcp') {
    process.stderr.write(`WEATHER_SOURCE must be "api" or "mcp", got "${WEATHER_SOURCE}".\n`)
    return 2
  }

  const client = new OpenRouter({ apiKey })
  let closeTools = async (): Promise<void> => {}

  try {
    let tools: readonly Tool[] = [getWeather]
    if (WEATHER_SOURCE === 'mcp') {
      const mcp = await connectWeatherMcp()
      tools = mcp.tools
      closeTools = mcp.close
    }

    // `callModel` runs the whole tool loop: it calls the model, executes
    // the weather tools when asked, feeds the results back, and keeps going.
    const result = client.callModel({
      model: MODEL,
      input: prompt,
      tools,
      stopWhen: stepCountIs(MAX_STEPS),
      // Constrains the reply to ANSWER_SCHEMA. Not streamed: a half-written
      // object is not valid JSON, so there is nothing useful to emit early.
      text: {
        format: {
          type: 'json_schema',
          name: 'weather_answer',
          schema: ANSWER_SCHEMA,
          strict: true,
        },
      },
    })

    const text = await result.getText()

    // The JSON goes to stdout and everything else to stderr, so
    // `npm start -- "..." > out.json` captures only the answer.
    process.stdout.write(`${JSON.stringify(parseAnswer(text), null, 2)}\n`)

    const usage = (await result.getResponse()).usage
    if (usage !== undefined && usage !== null) process.stderr.write(summarize(usage))
  } catch (error) {
    process.stderr.write(`${describe(error)}\n`)
    return 1
  } finally {
    // An open MCP connection would keep the process alive after `main` returns.
    await closeTools()
  }

  return 0
}

/**
 * `strict` should guarantee a conforming object, but a provider that ignores
 * the schema would otherwise surface as a confusing crash — so fail loudly
 * with the offending text instead.
 */
function parseAnswer(text: string): Answer {
  try {
    return JSON.parse(text) as Answer
  } catch {
    throw new Error(`Model did not return JSON matching the schema: ${text.trim()}`)
  }
}

type TokenUsage = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cost?: number | null | undefined
}

function summarize(usage: TokenUsage): string {
  const cost = typeof usage.cost === 'number' ? `, $${usage.cost.toFixed(6)}` : ''
  return (
    `[${MODEL}] ${usage.inputTokens} input + ` +
    `${usage.outputTokens} output = ${usage.totalTokens} tokens${cost}\n`
  )
}

/**
 * Checked structurally rather than with `instanceof`: the agent SDK bundles its
 * own copy of the base SDK, so its error classes are not the ones a top-level
 * `@openrouter/sdk` import would give us and `instanceof` would never match.
 */
function describe(error: unknown): string {
  const status = hasStatusCode(error) ? ` (HTTP ${error.statusCode})` : ''
  const detail = error instanceof Error ? error.message : String(error)
  return `OpenRouter request failed${status}: ${detail}`
}

function hasStatusCode(error: unknown): error is { statusCode: number } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    typeof (error as { statusCode: unknown }).statusCode === 'number'
  )
}

process.exitCode = await main()
