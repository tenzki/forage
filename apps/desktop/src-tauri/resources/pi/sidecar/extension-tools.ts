import { Type } from '@earendil-works/pi-ai'
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { ExtensionRuntimeLog, LoadedForageExtension } from '@forage/extension-host'

export interface ExtensionToolAdapterOptions {
  signal: AbortSignal
  secrets?: Readonly<Record<string, Readonly<Record<string, string | undefined>>>>
  onProgress?: (installationId: string, extensionId: string, toolId: string, progress: unknown) => void
  onLog?: (entry: ExtensionRuntimeLog) => void
}

/** Private adapter: Forage extensions never receive Pi session or tool objects. */
export function adaptExtensionTools(
  extensions: readonly LoadedForageExtension[],
  allowedToolIds: ReadonlySet<string>,
  options: ExtensionToolAdapterOptions,
): ToolDefinition[] {
  return extensions.flatMap((extension) => [...extension.tools.values()].flatMap((tool) => {
    if (!allowedToolIds.has(tool.id)) return []
    const installationId = extension.entry.source.installationId
    const extensionId = extension.entry.manifest!.id
    return [defineTool({
      name: tool.id,
      label: tool.name,
      description: tool.description,
      parameters: Type.Unsafe(tool.inputSchema),
      async execute(_toolCallId, input, signal) {
        const combined = signal ? AbortSignal.any([options.signal, signal]) : options.signal
        const result = await extension.executeTool(tool.id, input, {
          signal: combined,
          secrets: options.secrets?.[installationId],
          onProgress: (progress) => options.onProgress?.(installationId, extensionId, tool.id, progress),
          onLog: options.onLog,
        })
        return {
          content: [{ type: 'text' as const, text: 'text' in result ? result.text : JSON.stringify(result.json) }],
          details: { extension: installationId, json: 'json' in result ? result.json : null },
        }
      },
    })]
  }))
}
