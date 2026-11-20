import { OpenRouter, stepCountIs, tool } from '@openrouter/agent'
import { MAX_STEPS, type RunModel } from './agent.ts'

/** Der einzige Ort, der das Netz anfasst. */
export function openRouterModel(apiKey: string, model: string): RunModel {
  const client = new OpenRouter({ apiKey })
  return async ({ instructions, input, tools }) => {
    const result = client.callModel({
      model,
      instructions,
      input,
      tools: tools.map((t) =>
        tool({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          execute: t.execute,
        }),
      ),
      stopWhen: stepCountIs(MAX_STEPS),
    })
    // Wartet, bis der Tool-Loop durch ist; der Schlusssatz des Modells wird nicht gebraucht.
    await result.getText()
  }
}
