import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import {
  AgentRuntimeError,
  MAX_ANSWER_CHARS,
  parseStructuredResult,
  requireStructuredResultV1,
  type ActivityEvent,
  type LocalAnswerResult,
  type LocalRunResult,
  type RunInput,
  type RuntimeTool,
  type StructuredResult,
  type StructuredResultNode,
  type UntrustedSourceMaterial,
} from '@forage/agent-runtime'
import {
  CONVERSATION_UNAVAILABLE,
  createAuthenticatedModelRuntime,
  ModelProviderError,
  resolveModel,
  runPiTurn,
  turnRequestFromRunInput,
  type ConversationStore,
  type EmittedOutline,
  type ImageReferences,
  type MaterializedOutline,
  type ModelAuth,
  type OutlineImage,
  type PiTurnAdapters,
} from '@forage/pi-runtime'
import type { ResolvedModelCredential } from './credentialService.js'
import { ProviderError } from './transcript.js'

/** The Pi model runtime and model one server run executes with. */
export type ServerPiModel = Pick<PiTurnAdapters, 'modelRuntime' | 'model'>

export function modelAuth(credential: ResolvedModelCredential): ModelAuth {
  if (credential.provider === 'openai') return { providerId: 'openai', accessToken: credential.apiKey }
  return {
    providerId: 'openai-codex',
    accessToken: credential.accessToken,
    accountId: credential.accountId,
    expires: Date.parse(credential.expiresAt),
  }
}

/** Build an in-memory Pi model runtime from a resolved server credential; nothing touches disk. */
export async function createServerPiModel(credential: ResolvedModelCredential, modelId: string): Promise<ServerPiModel> {
  const auth = modelAuth(credential)
  let modelRuntime: ServerPiModel['modelRuntime']
  try {
    modelRuntime = await createAuthenticatedModelRuntime(auth)
  } catch {
    throw new ProviderError('authentication_required', 'Model provider authentication is required.', false)
  }
  try {
    return { modelRuntime, model: resolveModel(modelRuntime, auth.providerId, modelId).model }
  } catch {
    throw new ProviderError('invalid_input', 'Model provider rejected the request.', false)
  }
}

/**
 * Images `generate_image` created in this run. The model references them by `imageId`
 * in `emit_outline`; each resolves to the completed content-addressed asset.
 */
export class ServerImageReferences implements ImageReferences {
  private readonly images = new Map<string, OutlineImage>()

  register(asset: { assetId: string; alt: string }): string {
    const imageId = `img_${randomUUID().replaceAll('-', '')}`
    this.images.set(imageId, { src: asset.assetId, prompt: asset.alt })
    return imageId
  }

  get(imageId: string): OutlineImage | undefined {
    return this.images.get(imageId)
  }
}

/** Give each generated asset an `imageId` the result can place; other tools pass through. */
export function withImageReferences(tool: RuntimeTool, images: ServerImageReferences): RuntimeTool {
  if (tool.id !== 'generate_image') return tool
  return {
    ...tool,
    execute: async (arguments_, signal) => {
      const output = await tool.execute(arguments_, signal)
      return isGeneratedAsset(output) ? { imageId: images.register(output), ...output } : output
    },
  }
}

export interface ServerPiTurnOptions {
  model: ServerPiModel
  tools: readonly RuntimeTool[]
  /** Material an automation run starts from, presented as untrusted. */
  sources?: UntrustedSourceMaterial[]
  onActivity: (event: ActivityEvent) => Promise<void>
  signal: AbortSignal
  maxToolRounds?: number
  /** The call's conversation for a run that carries a thread; replies require it. */
  conversation?: ConversationStore
}

/**
 * Run a server agent run as one Pi turn and return what to commit: a v1 structured
 * result, or an inline answer from a reply. A first turn, including every Inbox
 * automation run, must end with `emit_outline`; prose fails with `structured_result_required`.
 */
export async function runServerPiTurn(input: RunInput, options: ServerPiTurnOptions): Promise<LocalRunResult> {
  const images = new ServerImageReferences()
  let activity: Promise<void> = Promise.resolve()
  let outcome: Awaited<ReturnType<typeof runPiTurn>>
  try {
    outcome = await runPiTurn(turnRequestFromRunInput(input, options.sources), {
      ...options.model,
      runtimeTools: options.tools.map((tool) => withImageReferences(tool, images)),
      images,
      ...(options.conversation ? { conversation: options.conversation } : {}),
      onActivity: (event) => { activity = activity.then(() => options.onActivity(event)) },
    }, {
      signal: options.signal,
      ...(options.maxToolRounds === undefined ? {} : { maxToolRounds: options.maxToolRounds }),
      cwd: tmpdir(),
    })
  } catch (error) {
    await activity.catch(() => undefined)
    throw providerFailure(error)
  }
  await activity
  if (outcome.type === 'outline') return structuredResultFromOutline(outcome.outline)
  if ((input.thread?.turn ?? 1) < 2) {
    throw new AgentRuntimeError('structured_result_required', 'Model did not return a structured result')
  }
  return answerResult(outcome.text)
}

function answerResult(text: string): LocalAnswerResult {
  const trimmed = text.trim()
  return {
    version: 1,
    type: 'answer',
    text: trimmed.length > MAX_ANSWER_CHARS ? `${trimmed.slice(0, MAX_ANSWER_CHARS - 1).trimEnd()}…` : trimmed,
  }
}

/** The committed result for an emitted outline; image nodes reference their server asset. */
export function structuredResultFromOutline(outline: EmittedOutline): StructuredResult {
  try {
    return requireStructuredResultV1(parseStructuredResult({
      version: 1,
      nodes: outline.nodes.map(resultNode),
      sources: outline.sources,
    }))
  } catch {
    throw new AgentRuntimeError('invalid_output', 'The emitted outline is not a valid structured result.')
  }
}

function resultNode(node: MaterializedOutline): StructuredResultNode {
  if ('type' in node) return { type: 'image', assetId: node.image.src, alt: node.image.alt }
  return {
    type: 'text',
    text: node.text,
    ...(node.children?.length ? { children: node.children.map(resultNode) } : {}),
  }
}

/** Map a provider failure to the failure codes the legacy model adapter used. */
function providerFailure(error: unknown): unknown {
  if (error instanceof Error && !(error instanceof AgentRuntimeError) && error.message === CONVERSATION_UNAVAILABLE) {
    return new AgentRuntimeError('conversation_unavailable', CONVERSATION_UNAVAILABLE)
  }
  if (!(error instanceof ModelProviderError)) return error
  const message = error.message
  if (/\b40[13]\b|unauthori[sz]ed|invalid.{0,10}api.?key|authenticat|expired/i.test(message)) {
    return new ProviderError('authentication_required', 'Model provider authentication is required.', false)
  }
  if (/\b429\b|rate.?limit/i.test(message)) {
    return new ProviderError('provider_rate_limited', 'Model provider rate limited the request.', true)
  }
  if (/\b(?:400|404|413|422)\b/.test(message)) {
    return new ProviderError('invalid_input', 'Model provider rejected the request.', false)
  }
  return new ProviderError('dependency_unavailable', 'Model provider is temporarily unavailable.', true)
}

function isGeneratedAsset(value: unknown): value is { assetId: string; alt: string } {
  const asset = value as { assetId?: unknown; alt?: unknown } | null
  return Boolean(asset) && typeof asset === 'object'
    && typeof asset!.assetId === 'string' && /^[a-f0-9]{64}$/.test(asset!.assetId)
    && typeof asset!.alt === 'string'
}
