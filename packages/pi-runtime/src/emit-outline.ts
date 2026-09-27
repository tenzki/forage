import { Type } from '@earendil-works/pi-ai'
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { SourceReference, VerifiedSources } from './sources'

export const EMIT_OUTLINE_TOOL = 'emit_outline'

export interface OutlineTextNode {
  text: string
  children?: OutlineNode[]
}

export interface OutlineImageNode {
  imageId: string
  imageAlt?: string
}

export type OutlineNode = OutlineTextNode | OutlineImageNode

/** A generated image a node may reference. `src` is environment-specific: a data URL locally, an asset reference on the server. */
export interface OutlineImage {
  src: string
  prompt: string
}

/** Resolves image IDs returned by image tools in this turn. */
export interface ImageReferences {
  get(imageId: string): OutlineImage | undefined
}

export type MaterializedOutline =
  | { text: string; children?: MaterializedOutline[] }
  | { type: 'image'; image: { src: string; alt: string } }

/** What a successful `emit_outline` call returns in its tool result details. */
export interface EmittedOutline {
  action: 'emit_outline'
  nodes: MaterializedOutline[]
  sources: SourceReference[]
}

export function createEmitOutlineTool(images: ImageReferences, sources: VerifiedSources): ToolDefinition {
  const imageId = Type.String({ pattern: '^img_[a-f0-9]{32}$' })
  const imageAlt = Type.Optional(Type.String({ minLength: 1, maxLength: 500 }))
  const ImageNode = Type.Object({ imageId, imageAlt })
  const TextLeaf = Type.Object({ text: Type.String({ minLength: 1, maxLength: 10_000 }) })
  const Leaf = Type.Union([TextLeaf, ImageNode])
  const TextWithChildren = Type.Object({
    text: Type.String({ minLength: 1, maxLength: 10_000 }),
    children: Type.Optional(Type.Array(Leaf, { maxItems: 100 })),
  })
  const RootNode = Type.Union([TextWithChildren, ImageNode])
  const Source = Type.Object({
    url: Type.String({ minLength: 1, maxLength: 2_000 }),
    label: Type.String({ minLength: 1, maxLength: 300 }),
  })

  return defineTool({
    name: EMIT_OUTLINE_TOOL,
    label: 'Emit Outline',
    description: 'Return the final answer as structured text or image outline nodes. A generated image must be a separate image-only node using the imageId returned by an image tool. List the pages you read in sources.',
    promptSnippet: 'Emit the final response as nested text nodes and separate generated-image nodes',
    promptGuidelines: [
      'Use emit_outline as the final action for every task.',
      'Emit each generated image as its own image-only node with imageId and imageAlt; never attach it to a text node.',
    ],
    parameters: Type.Object({
      nodes: Type.Array(RootNode, { minItems: 1, maxItems: 100 }),
      sources: Type.Optional(Type.Array(Source, { maxItems: 100 })),
    }),
    async execute(_toolCallId, params) {
      const inputNodes = params.nodes as OutlineNode[]
      const details: EmittedOutline = {
        action: 'emit_outline',
        nodes: materializeOutline(inputNodes, images),
        sources: sources.filter(params.sources ?? []).map(({ url, label }) => ({ url, label })),
      }
      return {
        content: [{ type: 'text', text: `Created ${inputNodes.length} outline node(s).` }],
        details,
        terminate: true,
      }
    },
  })
}

function materializeOutline(nodes: OutlineNode[], images: ImageReferences): MaterializedOutline[] {
  return nodes.map((node) => {
    if ('imageId' in node) {
      const stored = images.get(node.imageId)
      if (!stored) throw new Error('emit_outline referenced an unknown generated image.')
      return {
        type: 'image' as const,
        image: { src: stored.src, alt: node.imageAlt?.trim() || stored.prompt.slice(0, 500) },
      }
    }
    const children = node.children?.length ? materializeOutline(node.children, images) : undefined
    return { text: node.text, ...(children ? { children } : {}) }
  })
}

export function isEmittedOutline(value: unknown): value is EmittedOutline {
  return Boolean(value) && typeof value === 'object'
    && (value as { action?: unknown }).action === 'emit_outline'
    && Array.isArray((value as { nodes?: unknown }).nodes)
}
