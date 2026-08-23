import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  Provider,
  ToolCall,
  ToolResultMessage,
} from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import type { CodexAuthMode } from '../store/settingsStore'
import {
  validCodexCredential,
  type CodexOAuthCredential,
} from './codexAuth'
import type { AgentDefinition } from './definitions'
import type { Skill } from './skills'
import {
  resolveTools,
  type CustomHttpToolConfig,
  type ExecutableTool,
} from './tools'

const MAX_TOKENS = 1500
const MAX_TOOL_ROUNDS = 10
const DEFAULT_MODELS: Record<CodexAuthMode, string> = {
  subscription: 'gpt-5.5',
  api_key: 'gpt-5.3-codex',
}

export interface GenerateOptions {
  onDelta: (textSoFar: string) => void
  onToolActivity?: (notes: string[]) => void
  signal?: AbortSignal
}

export interface GenerateInput {
  skill: Skill
  agent?: AgentDefinition
  prompt: string
  context: string[]
  siblings?: string[]
  enabledToolIds?: string[]
  customTools?: CustomHttpToolConfig[]
}

export interface CodexAuthConfig {
  mode: CodexAuthMode
  apiKey: string
  oauthCredential: CodexOAuthCredential | null
  modelId: string
  onCredentialRefresh?: (credential: CodexOAuthCredential) => Promise<void>
}

export interface CodexModelOption {
  id: string
  name: string
}

function providerFor(mode: CodexAuthMode): Provider {
  return mode === 'subscription' ? openaiCodexProvider() : openaiProvider()
}

function modelsFor(mode: CodexAuthMode): Model<Api>[] {
  const models = providerFor(mode).getModels()
  return mode === 'subscription'
    ? [...models]
    : models.filter((model) => model.id.includes('codex'))
}

export function codexModelOptions(mode: CodexAuthMode): CodexModelOption[] {
  return modelsFor(mode).map(({ id, name }) => ({ id, name }))
}

export function defaultCodexModel(mode: CodexAuthMode): string {
  const models = modelsFor(mode)
  const preferred = DEFAULT_MODELS[mode]
  return models.some((model) => model.id === preferred) ? preferred : (models[0]?.id ?? preferred)
}

function resolveModel(mode: CodexAuthMode, modelId: string): Model<Api> {
  const models = modelsFor(mode)
  const fallback = defaultCodexModel(mode)
  const model = models.find((item) => item.id === modelId)
    ?? models.find((item) => item.id === fallback)
  if (!model) throw new Error('No Codex model is available for the selected authentication method.')
  return model
}

export async function resolveAccessToken(
  auth: CodexAuthConfig,
  signal?: AbortSignal,
): Promise<string> {
  if (auth.mode === 'api_key') {
    if (!auth.apiKey.trim()) {
      throw new Error('No OpenAI API key set. Open Settings and add your API key.')
    }
    return auth.apiKey.trim()
  }
  if (!auth.oauthCredential) {
    throw new Error('Not signed in to ChatGPT. Open Settings and connect your subscription.')
  }
  const credential = await validCodexCredential(auth.oauthCredential, signal)
  if (credential !== auth.oauthCredential) await auth.onCredentialRefresh?.(credential)
  return credential.access
}

function userMessage({ skill, prompt, context, siblings = [] }: GenerateInput): Context {
  const contextBlock = context.length
    ? `Selected outline context (hierarchy preserved by indentation):\n${context.map((item) => /^\s*-\s/.test(item) ? item : `- ${item}`).join('\n')}\n\n`
    : ''
  const siblingBlock = siblings.length
    ? `Direct sibling bullets (same parent):\n${siblings.map((item) => `- ${item}`).join('\n')}\n\n`
    : ''
  return {
    systemPrompt: skill.systemPrompt,
    messages: [{
      role: 'user',
      content: `${contextBlock}${siblingBlock}Task: ${prompt}`,
      timestamp: Date.now(),
    }],
  }
}

const desktopFetch: typeof globalThis.fetch = (input, init) => tauriFetch(input, init)

function toolResult(call: ToolCall, text: string, isError: boolean): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: 'text', text }],
    isError,
    timestamp: Date.now(),
  }
}

async function executeTool(
  call: ToolCall,
  tools: ExecutableTool[],
  signal?: AbortSignal,
): Promise<ToolResultMessage> {
  const tool = tools.find((item) => item.definition.name === call.name)
  if (!tool) return toolResult(call, `Unknown or disabled tool: ${call.name}`, true)
  try {
    const output = await tool.execute(call.arguments, signal)
    return toolResult(call, output, false)
  } catch (error) {
    if (signal?.aborted) throw error
    const detail = error instanceof Error ? error.message : String(error)
    return toolResult(call, detail, true)
  }
}

function activityNotes(calls: ToolCall[], tools: ExecutableTool[]): string[] {
  return calls.map((call) => {
    const tool = tools.find((item) => item.definition.name === call.name)
    if (!tool) return `calling ${call.name}`
    try {
      return tool.activity(call.arguments)
    } catch {
      return `calling ${call.name}`
    }
  })
}

async function streamTurn(
  provider: Provider,
  model: Model<Api>,
  context: Context,
  apiKey: string,
  options: GenerateOptions,
): Promise<AssistantMessage> {
  const stream = provider.streamSimple(model, context, {
    apiKey,
    fetch: desktopFetch,
    maxTokens: MAX_TOKENS,
    reasoning: 'low',
    signal: options.signal,
    transport: 'sse',
  })
  let text = ''
  for await (const event of stream) {
    if (event.type === 'text_delta') {
      text += event.delta
      options.onDelta(text)
    } else if (event.type === 'done') {
      return event.message
    } else if (event.type === 'error') {
      throw new Error(event.error.errorMessage || 'Codex generation failed.')
    }
  }
  throw new Error('Codex generation ended without a final response.')
}

export async function generate(
  auth: CodexAuthConfig,
  input: GenerateInput,
  { onDelta, onToolActivity, signal }: GenerateOptions,
): Promise<string> {
  const apiKey = await resolveAccessToken(auth, signal)
  const provider = providerFor(auth.mode)
  const model = resolveModel(auth.mode, auth.modelId)
  const tools = resolveTools(input.enabledToolIds ?? [], input.customTools)
  const context = userMessage(input)
  context.tools = tools.map((tool) => tool.definition)

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    const assistant = await streamTurn(provider, model, context, apiKey, { onDelta, signal })
    const calls = assistant.content.filter((item): item is ToolCall => item.type === 'toolCall')
    if (!calls.length) {
      return assistant.content
        .filter((item) => item.type === 'text')
        .map((item) => item.text)
        .join('')
    }
    if (round === MAX_TOOL_ROUNDS) throw new Error('Tool-call limit reached.')
    context.messages.push(assistant)
    onToolActivity?.(activityNotes(calls, tools))
    const results = await Promise.all(calls.map((call) => executeTool(call, tools, signal)))
    context.messages.push(...results)
  }
  throw new Error('Tool-call limit reached.')
}
