import { AgentRuntimeError } from '@forage/agent-runtime'

export interface NamedTool {
  name: string
}

export const UNAUTHORIZED_TOOL_MESSAGE = 'Tool is not authorized for this run.'

/**
 * The tools a turn may call: every provided tool in the run's effective set, plus the
 * output tool, which no other provider can replace. Fails before any model call when a
 * required tool is missing.
 */
export function selectEffectiveTools<T extends NamedTool>(options: {
  tools: readonly T[]
  authorizedToolIds: ReadonlySet<string>
  requiredToolIds: readonly string[]
  outputTool: T
}): T[] {
  const selected = options.tools
    .filter((tool) => options.authorizedToolIds.has(tool.name) && tool.name !== options.outputTool.name)
  const duplicate = selected.find((tool, index) => selected.findIndex((candidate) => candidate.name === tool.name) !== index)
  if (duplicate) throw new Error(`Tool ${duplicate.name} has more than one active provider.`)
  const available = new Set(selected.map((tool) => tool.name).concat(options.outputTool.name))
  const missingRequired = options.requiredToolIds.filter((toolId) => !available.has(toolId))
  if (missingRequired.length) {
    throw new AgentRuntimeError('required_tool_unavailable', `Required tool is unavailable: ${missingRequired.join(', ')}`)
  }
  return [...selected, options.outputTool]
}
