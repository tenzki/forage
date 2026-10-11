import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter'
import { opencodeGoProvider } from '@earendil-works/pi-ai/providers/opencode-go'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { MODEL_PROVIDERS, type ModelProvider, type ProviderCapability } from '@forage/agent-runtime'

const factories = {
  anthropic: anthropicProvider,
  openrouter: openrouterProvider,
  'opencode-go': opencodeGoProvider,
  openai: openaiProvider,
  'openai-codex': openaiCodexProvider,
}

export function getProviderModels(provider: ModelProvider) {
  return factories[provider]().getModels()
}

export function getProviderCapabilities(providers: readonly ModelProvider[]): ProviderCapability[] {
  return MODEL_PROVIDERS.filter((descriptor) => providers.includes(descriptor.id)).map((descriptor) => ({
    provider: descriptor.id,
    authentication: descriptor.authentication,
    modelIds: getProviderModels(descriptor.id).map((model) => model.id),
  }))
}
