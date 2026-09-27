import { Type } from '@earendil-works/pi-ai'
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import { extensionToolResultSchema } from '@forage/agent-runtime'
import type { OutlineImage } from '@forage/pi-runtime'
import type { ExtensionRuntimeLog, LoadedForageExtension } from '@forage/extension-host'

export interface ExtensionToolAdapterOptions {
  images?: Map<string, OutlineImage>
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
      async execute(_toolCallId, input, signal): Promise<{
        content: Array<{ type: 'text'; text: string }>
        details: Record<string, unknown>
      }> {
        const combined = signal ? AbortSignal.any([options.signal, signal]) : options.signal
        const rawResult = await extension.executeTool(tool.id, input, {
          signal: combined,
          secrets: options.secrets?.[installationId],
          onProgress: (progress) => options.onProgress?.(installationId, extensionId, tool.id, progress),
          onLog: options.onLog,
        })
        combined.throwIfAborted()
        const result = extensionToolResultSchema.parse(rawResult)
        if ('image' in result) {
          if (!options.images) throw new Error('Image output is unavailable in this run.')
          if (options.images.size >= 1) throw new Error('At most one image can be returned in one run.')
          const { mediaType, base64, alt } = result.image
          const bytes = Buffer.from(base64, 'base64')
          const valid = mediaType === 'image/png'
            ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            : mediaType === 'image/webp'
              ? bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
              : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
          if (!valid || bytes.toString('base64') !== base64) throw new Error('Extension returned an invalid raster image.')
          const imageId = `img_${crypto.randomUUID().replace(/-/g, '')}`
          options.images.set(imageId, { src: `data:${mediaType};base64,${base64}`, prompt: alt })
          return {
            content: [{ type: 'text' as const, text: `Generated image ${imageId}. Use this exact imageId in a separate image-only emit_outline node.` }],
            details: { extension: installationId, action: 'generated_image', imageId },
          }
        }
        return {
          content: [{ type: 'text' as const, text: 'text' in result ? result.text : JSON.stringify(result.json) }],
          details: { extension: installationId, json: 'json' in result ? result.json : null },
        }
      },
    })]
  }))
}
