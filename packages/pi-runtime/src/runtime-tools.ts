import { Type } from '@earendil-works/pi-ai'
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import {
  boundedSafeError,
  boundedToolOutput,
  isAbortError,
  untrustedSourceMaterialSchema,
  type RuntimeTool,
} from '@forage/agent-runtime'
import type { VerifiedSources } from './sources'

/**
 * Expose an environment `RuntimeTool` to Pi. Output is bounded before it reaches the
 * model, untrusted source material registers its canonical URL as a verified source,
 * and errors reach the model with credentials redacted.
 */
export function adaptRuntimeTool(tool: RuntimeTool, sources: VerifiedSources): ToolDefinition {
  return defineTool({
    name: tool.id,
    label: tool.name,
    description: tool.description,
    parameters: tool.inputSchema ? Type.Unsafe(tool.inputSchema) : Type.Object({}, { additionalProperties: true }),
    async execute(_toolCallId, params, signal) {
      const toolSignal = signal ?? new AbortController().signal
      let output: unknown
      try {
        output = await tool.execute(params as Record<string, unknown>, toolSignal)
      } catch (error) {
        if (toolSignal.aborted || isAbortError(error)) throw error
        throw new Error(boundedSafeError(error))
      }
      const source = untrustedSourceMaterialSchema.safeParse(output)
      if (source.success) sources.register(source.data.canonicalUrl)
      return { content: [{ type: 'text', text: boundedToolOutput(output) }], details: {} }
    },
  })
}
