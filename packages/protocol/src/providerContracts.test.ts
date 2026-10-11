import { describe, expect, it } from 'vitest'
import { MODEL_PROVIDERS } from '@forage/agent-runtime'
import { apiKeyEnrollmentRequestSchema, credentialImportRequestSchema, credentialMetadataSchema, serverReadinessSchema } from './agent'

describe('provider protocol compatibility', () => {
  it.each(MODEL_PROVIDERS)('validates $id enrollment and non-secret metadata', (descriptor) => {
    const metadata = {
      id: 'credential-1', provider: descriptor.id, status: 'connected',
      createdAt: '2026-09-29T12:00:00Z', updatedAt: '2026-09-29T12:00:00Z',
    }
    expect(credentialMetadataSchema.parse(metadata)).toEqual(metadata)
    expect(credentialMetadataSchema.safeParse({ ...metadata, apiKey: 'secret' }).success).toBe(false)
    const keyRequest = { provider: descriptor.id, apiKey: 'sk-fixture-not-a-live-key' }
    if (descriptor.authentication === 'api_key') {
      expect(apiKeyEnrollmentRequestSchema.parse(keyRequest)).toEqual(keyRequest)
      expect(credentialImportRequestSchema.parse(keyRequest)).toEqual(keyRequest)
      expect(credentialImportRequestSchema.safeParse({ ...keyRequest, accountId: 'oauth-account' }).success).toBe(false)
    } else {
      expect(apiKeyEnrollmentRequestSchema.safeParse(keyRequest).success).toBe(false)
      expect(credentialImportRequestSchema.safeParse(keyRequest).success).toBe(false)
      const oauth = {
        provider: descriptor.id, accessToken: 'fixture-access-token-not-live', refreshToken: 'fixture-refresh-token-not-live',
        accountId: 'account-1', expiresAt: '2030-01-01T00:00:00Z',
      }
      expect(credentialImportRequestSchema.parse(oauth)).toEqual(oauth)
      expect(credentialImportRequestSchema.safeParse({ ...oauth, apiKey: 'secret' }).success).toBe(false)
    }
  })

  it('reads older readiness responses without inventing supported providers', () => {
    const legacy = {
      connection: { ready: true }, outlineSync: { ready: true }, agentConfiguration: { ready: true },
      computeProfile: { ready: true }, worker: { ready: true }, noteIndex: { ready: true }, admissionProtocolVersions: [1, 2],
    }
    expect(serverReadinessSchema.parse(legacy)).toEqual(legacy)
    expect(serverReadinessSchema.parse(legacy).supportedProviders).toBeUndefined()
  })
})
