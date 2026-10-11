import { z } from 'zod'

export const apiKeyProviderSchema = z.enum(['anthropic', 'openrouter', 'opencode-go', 'openai'])
export const modelProviderSchema = z.enum(['anthropic', 'openrouter', 'opencode-go', 'openai', 'openai-codex'])
export type ModelProvider = z.infer<typeof modelProviderSchema>
export type ProviderAuthentication = 'api_key' | 'oauth'
export const providerModelIdSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9~._:/-]+$/)

export const MODEL_PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic', authentication: 'api_key', runtimeProviderId: 'anthropic' },
  { id: 'openrouter', label: 'OpenRouter', authentication: 'api_key', runtimeProviderId: 'openrouter' },
  { id: 'opencode-go', label: 'OpenCode Go', authentication: 'api_key', runtimeProviderId: 'opencode-go' },
  { id: 'openai', label: 'OpenAI', authentication: 'api_key', runtimeProviderId: 'openai' },
  { id: 'openai-codex', label: 'ChatGPT', authentication: 'oauth', runtimeProviderId: 'openai-codex' },
] as const satisfies readonly {
  id: ModelProvider
  label: string
  authentication: ProviderAuthentication
  runtimeProviderId: ModelProvider
}[]

export const providerCapabilitySchema = z.object({
  provider: modelProviderSchema,
  authentication: z.enum(['api_key', 'oauth']),
  modelIds: z.array(providerModelIdSchema).min(1).max(2_000)
    .refine((ids) => new Set(ids).size === ids.length, 'Models must be unique'),
}).strict().superRefine((capability, context) => {
  const descriptor = MODEL_PROVIDERS.find((provider) => provider.id === capability.provider)!
  if (descriptor.authentication !== capability.authentication) {
    context.addIssue({ code: 'custom', path: ['authentication'], message: 'Unsupported provider authentication' })
  }
})

export const providerCapabilitiesSchema = z.array(providerCapabilitySchema).max(MODEL_PROVIDERS.length)
  .refine((entries) => new Set(entries.map((entry) => entry.provider)).size === entries.length, 'Providers must be unique')
export type ProviderCapability = z.infer<typeof providerCapabilitySchema>

export function supportsProviderSelection(
  capabilities: readonly ProviderCapability[] | undefined,
  selection: { provider: ModelProvider; modelId: string },
): boolean {
  return capabilities?.some((entry) => entry.provider === selection.provider && entry.modelIds.includes(selection.modelId)) ?? false
}
