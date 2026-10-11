import type { CustomHttpToolConfig } from './tools'

export function normalizeCustomToolReferences(customTools: readonly CustomHttpToolConfig[], reservedToolIds: readonly string[] = []) {
  const runtimeIds = new Map(customTools.map((tool) => [
    tool.id,
    /^[a-z][a-z0-9_]{0,63}$/.test(tool.id) ? tool.id : tool.name.trim().toLowerCase(),
  ]))
  const reserved = new Set(reservedToolIds)
  const normalizedTools = customTools.map((tool) => ({ ...tool, id: runtimeIds.get(tool.id)! }))
  if (normalizedTools.some((tool) => reserved.has(tool.id)) || new Set(normalizedTools.map((tool) => tool.id)).size !== normalizedTools.length) {
    throw new Error('A custom HTTP tool identifier conflicts with another tool. Rename the custom tool before running this agent.')
  }
  return {
    customTools: normalizedTools,
    normalizeToolIds: (ids: readonly string[]) => [...new Set(ids.map((id) => runtimeIds.get(id) ?? id))],
  }
}
