import type { Tool } from '@openrouter/agent'
import { createMCPTools } from '@openrouter/agent/mcp'

/**
 * A public Open-Meteo MCP server (https://github.com/cyanheads/open-meteo-mcp-server).
 * Keyless like the direct API, so swapping it in needs no new secret. Override
 * with WEATHER_MCP_URL to point at a self-hosted instance.
 */
const MCP_URL = process.env.WEATHER_MCP_URL ?? 'https://open-meteo.caseyjhand.com/mcp'

/**
 * The server exposes a dozen tools (marine, flood, climate, ...). Only the two
 * that answer "what is the weather in X" are offered, so the model is not
 * tempted into detours and the tool schemas do not bloat every request.
 */
const WEATHER_TOOLS = ['openmeteo_search_locations', 'openmeteo_get_forecast']

export type WeatherTools = {
  tools: readonly Tool[]
  close: () => Promise<void>
}

/**
 * Unlike `getWeather`, the model drives both hops itself here: it geocodes the
 * place, then asks for the forecast with `current_variables`. The handle holds
 * a live connection, so the caller must `close()` it when the run is done.
 */
export async function connectWeatherMcp(): Promise<WeatherTools> {
  const handle = await createMCPTools({
    url: MCP_URL,
    clientInfo: { name: 'openrouter-cli', version: '0.1.0' },
    includeTools: WEATHER_TOOLS,
  })
  return { tools: handle.tools, close: () => handle.close() }
}
