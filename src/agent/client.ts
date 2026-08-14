import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import type { Api, Context, Model, Provider } from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import type { CodexAuthMode } from '../store/settingsStore'
import {
  validCodexCredential,
  type CodexOAuthCredential,
} from './codexAuth'
import type { Skill } from './skills'

const MAX_TOKENS = 1500
const DEFAULT_MODELS: Record<CodexAuthMode, string> = {
  subscription: 'gpt-5.5',
  api_key: 'gpt-5.3-codex',
}

export interface GenerateOptions {
  onDelta: (textSoFar: string) => void
  signal?: AbortSignal
}

export interface GenerateInput {
  skill: Skill
  prompt: string
  context: string[]
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

async function resolveAccessToken(
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

function userMessage({ skill, prompt, context }: GenerateInput): Context {
  const contextBlock = context.length
    ? `Outline context (outer to inner):\n${context.map((item) => `- ${item}`).join('\n')}\n\n`
    : ''
  return {
    systemPrompt: skill.systemPrompt,
    messages: [{
      role: 'user',
      content: `${contextBlock}Task: ${prompt}`,
      timestamp: Date.now(),
    }],
  }
}

const desktopFetch: typeof globalThis.fetch = (input, init) => tauriFetch(input, init)

export async function generate(
  auth: CodexAuthConfig,
  input: GenerateInput,
  { onDelta, signal }: GenerateOptions,
): Promise<string> {
  const apiKey = await resolveAccessToken(auth, signal)
  const provider = providerFor(auth.mode)
  const model = resolveModel(auth.mode, auth.modelId)
  const stream = provider.streamSimple(model, userMessage(input), {
    apiKey,
    fetch: desktopFetch,
    maxTokens: MAX_TOKENS,
    reasoning: 'low',
    signal,
    transport: 'sse',
  })

  let full = ''
  for await (const event of stream) {
    if (event.type === 'text_delta') {
      full += event.delta
      onDelta(full)
    } else if (event.type === 'error') {
      throw new Error(event.error.errorMessage || 'Codex generation failed.')
    }
  }
  return full
}
