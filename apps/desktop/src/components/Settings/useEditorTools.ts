import { BUILTIN_TOOL_OPTIONS } from '../../agent/tools'
import { useSettingsStore } from '../../store/settingsStore'
import type { ExtensionToolOption } from '../../store/extensionStore'
import { mcpToolOptions } from '../../store/mcpStore'
import { useMcpConnections } from './useMcpConnections'
import type { SelectorTool } from './AgentEditors'

export function useEditorTools(extensionTools: ExtensionToolOption[], references: string[] = []) {
  const enabled = useSettingsStore((state) => state.enabledToolIds)
  const custom = useSettingsStore((state) => state.customTools)
  const mcp = useMcpConnections()
  const catalog: SelectorTool[] = [
    ...BUILTIN_TOOL_OPTIONS.map((tool) => ({ ...tool, group: 'Forage', available: true })),
    ...custom.map(({ id, name, description }) => ({ id, name, description, group: 'Custom HTTP', available: true })),
    ...extensionTools.map((tool) => ({ ...tool, group: `${tool.sourceName} · Extension`, available: tool.available && mcp.environment === 'local', unavailableReason: mcp.environment === 'local' ? tool.unavailableReason : 'Device-local extension tools are unavailable in this execution environment.' })),
    ...mcpToolOptions(mcp.connections).map((tool) => ({ ...tool, group: 'MCP' })),
  ].map((tool) => ({ ...tool, available: tool.available && enabled.includes(tool.id), unavailableReason: !enabled.includes(tool.id) ? 'Globally disabled. Enable this tool in its source settings first.' : 'unavailableReason' in tool && typeof tool.unavailableReason === 'string' ? tool.unavailableReason : undefined }))
  for (const id of references) if (!catalog.some((tool) => tool.id === id)) catalog.push({ id, name: id, description: 'Saved reference', group: 'Unavailable references', available: false, unavailableReason: 'Source is missing, unsupported, or unavailable in this environment.' })
  return { ...mcp, tools: catalog }
}
