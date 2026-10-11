import { z } from 'zod'
import { modelProviderSchema, providerModelIdSchema } from '@forage/agent-runtime'
import { LOCAL_CODEX_CREDENTIAL_ID, LOCAL_OPENAI_CREDENTIAL_ID } from '../agent/localCredentials'

export const LOCAL_SETTINGS_FIELD = 'localSettingsV1'

export const devicePreferencesSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']).catch('system'),
  outlineFont: z.enum(['default', 'system', 'serif', 'mono']).catch('default'),
  outlineFontSize: z.union([z.literal('default'), z.literal(12), z.literal(14), z.literal(16), z.literal(18), z.literal(20), z.literal(24)]).catch('default'),
  followSystemMotion: z.boolean().catch(true),
}).strict()
export type DevicePreferences = z.infer<typeof devicePreferencesSchema>
export const DEFAULT_DEVICE_PREFERENCES: DevicePreferences = devicePreferencesSchema.parse({})

export const localAccountMetadataSchema = z.object({
  id: z.string().trim().min(1).max(128),
  provider: modelProviderSchema,
  status: z.enum(['connected', 'authentication_required']),
  accountLabel: z.string().trim().min(1).max(300).optional(),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
}).strict()

export const localSettingsSchema = z.object({
  version: z.literal(1),
  accounts: z.array(localAccountMetadataSchema).max(5)
    .refine((accounts) => new Set(accounts.map((account) => account.provider)).size === accounts.length, 'Duplicate provider account')
    .refine((accounts) => new Set(accounts.map((account) => account.id)).size === accounts.length, 'Duplicate credential reference'),
  compute: z.object({
    provider: modelProviderSchema,
    modelId: providerModelIdSchema,
    credentialRef: z.string().trim().min(1).max(128),
  }).strict(),
  preferences: devicePreferencesSchema.catch(DEFAULT_DEVICE_PREFERENCES),
}).strict().superRefine((settings, context) => {
  const account = settings.accounts.find((entry) => entry.id === settings.compute.credentialRef)
  if (account && account.provider !== settings.compute.provider) {
    context.addIssue({ code: 'custom', path: ['compute', 'credentialRef'], message: 'Provider does not match credential reference' })
  }
})
export type LocalSettings = z.infer<typeof localSettingsSchema>

export function migrateLocalSettings(
  stored: unknown,
  legacy: { authMode?: unknown; modelId?: unknown; accounts: unknown },
): LocalSettings {
  if (stored !== undefined && stored !== null) return localSettingsSchema.parse(stored)
  const candidates = Array.isArray(legacy.accounts) ? legacy.accounts : []
  const accounts = candidates.map((candidate) => localAccountMetadataSchema.parse(candidate))
  const provider = legacy.authMode === 'api_key' ? 'openai' : 'openai-codex'
  return localSettingsSchema.parse({
    version: 1,
    accounts,
    compute: {
      provider,
      modelId: typeof legacy.modelId === 'string' && legacy.modelId ? legacy.modelId : 'gpt-5.5',
      credentialRef: accounts.find((account) => account.provider === provider)?.id
        ?? (provider === 'openai' ? LOCAL_OPENAI_CREDENTIAL_ID : LOCAL_CODEX_CREDENTIAL_ID),
    },
    preferences: DEFAULT_DEVICE_PREFERENCES,
  })
}
