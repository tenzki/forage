import {
  activityEventSchema,
  parseStructuredResult,
  type ActivityEvent as RuntimeActivityEvent,
  type StructuredResultNode,
} from '@forage/agent-runtime'
import type { CodexAuthConfig } from './client'
import { generateWithPi, type PiGenerateOptions, type PiOutlineNode } from './piGeneration'
import type { LocalRuntimeRunner } from './localExecutor'
import { NativeAssetRepository } from '../persistence/assetStore'
import type { GeneratedAssetIngestor } from './insertIntoEditor'

type PiGenerate = typeof generateWithPi

export interface PiLocalRunnerDependencies {
  resolveCredential: (reference: string) => Promise<CodexAuthConfig>
  generate?: PiGenerate
  assets?: GeneratedAssetIngestor
}

export function createPiLocalRunner(dependencies: PiLocalRunnerDependencies): LocalRuntimeRunner {
  const generate = dependencies.generate ?? generateWithPi
  const assets = dependencies.assets ?? new NativeAssetRepository()
  return async (input, options) => {
    let sequence = 0
    let outline: PiOutlineNode[] | null = null
    let text = ''
    const activityWrites: Promise<void>[] = []
    const auth = await dependencies.resolveCredential(input.credentialRef)
    const activity = async (event: Parameters<NonNullable<PiGenerateOptions['onActivity']>>[0]): Promise<void> => {
      sequence += 1
      const phase = event.phase
      const kind = ['thinking', 'tool', 'output', 'error'].includes(event.kind) ? event.kind : 'status'
      const status = phase === 'start' ? 'running'
        : phase === 'complete' ? 'success'
          : phase === 'cancelled' ? 'cancelled' : 'error'
      const runtimeEvent: RuntimeActivityEvent = activityEventSchema.parse({
        id: safeId(event.id, sequence),
        sequence,
        ...(event.callId ? { callId: safeId(event.callId, sequence) } : {}),
        phase,
        kind,
        label: event.label.slice(0, 200),
        ...(event.detail ? { detail: event.detail.slice(0, 2_000) } : {}),
        status,
        ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
      })
      await options.onActivity(runtimeEvent)
    }
    const finalText = await generate({ ...auth, modelId: input.agent.modelId || auth.modelId }, {
      skill: input.skill,
      agent: input.agent,
      prompt: input.prompt,
      context: input.context,
      enabledToolIds: input.effectiveToolIds,
      customTools: input.customTools ?? [],
      outlineSnapshot: input.outlineSnapshot,
    }, {
      signal: options.signal,
      onDelta: (nextText) => { text = nextText },
      onOutline: async (nodes) => { outline = nodes },
      onActivity: (event) => { activityWrites.push(activity(event)) },
    })
    await Promise.all(activityWrites)
    if (options.signal.aborted) throw new DOMException('Agent run cancelled.', 'AbortError')
    const nodes = outline
      ? await materializeNodes(outline, assets)
      : textNodes(text || finalText)
    return parseStructuredResult({ version: 1, nodes, sources: [] })
  }
}

function textNodes(text: string): StructuredResultNode[] {
  return text.split('\n').map((line) => line.trim()).filter(Boolean)
    .map((line) => ({ type: 'text', text: line }))
}

async function materializeNodes(
  nodes: PiOutlineNode[],
  assets: GeneratedAssetIngestor,
): Promise<StructuredResultNode[]> {
  return Promise.all(nodes.map(async (node): Promise<StructuredResultNode> => {
    if ('image' in node) {
      const image = await assets.ingestGeneratedImage(node.image)
      return { type: 'image', assetId: image.assetId, alt: image.alt }
    }
    const children = node.children?.length ? await materializeNodes(node.children, assets) : undefined
    return { type: 'text', text: node.text, ...(children?.length ? { children } : {}) }
  }))
}

function safeId(value: string, fallback: number): string {
  const safe = value.trim().replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 128)
  return safe && /^[A-Za-z0-9]/.test(safe) ? safe : `activity-${fallback}`
}
