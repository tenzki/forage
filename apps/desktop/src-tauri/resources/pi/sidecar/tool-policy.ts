export interface NamedTool {
  name: string
}

export function effectiveTools<T extends NamedTool>(options: {
  builtIns: readonly T[]
  custom: readonly T[]
  extensions: readonly T[]
  authorizedToolIds: ReadonlySet<string>
  requiredToolIds: readonly string[]
  outputTool: T
}): T[] {
  const selected = [...options.builtIns, ...options.custom, ...options.extensions]
    .filter((tool) => options.authorizedToolIds.has(tool.name) && tool.name !== options.outputTool.name)
  const duplicate = selected.find((tool, index) => selected.findIndex((candidate) => candidate.name === tool.name) !== index)
  if (duplicate) throw new Error(`Tool ${duplicate.name} has more than one active provider.`)
  const available = new Set(selected.map((tool) => tool.name).concat(options.outputTool.name))
  const missingRequired = options.requiredToolIds.filter((toolId) => !available.has(toolId))
  if (missingRequired.length) throw new Error(`Required tool is unavailable: ${missingRequired.join(', ')}`)
  return [...selected, options.outputTool]
}
