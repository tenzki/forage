import { describe, expect, it } from 'vitest'
import {
  agentActivityPageSchema,
  agentConfigurationPublishRequestSchema,
  agentConfigurationResponseSchema,
  agentRunAdmissionRequestSchema,
  agentRunAdmissionResponseSchema,
  agentRunCancelResponseSchema,
  agentRunDetailSchema,
  agentRunListQuerySchema,
  agentRunRetryResponseSchema,
  automationPolicySetSchema,
  credentialMetadataSchema,
  deviceAuthorizationStartResponseSchema,
  deviceAuthorizationStatusSchema,
} from './index'

const agent = {
  id: 'research-agent', name: 'Research agent', description: 'Finds sources.',
  systemPrompt: 'Research carefully.', modelId: 'gpt-5', toolIds: ['web_fetch'],
}
const skill = {
  id: 'research', label: 'research', description: 'Research a URL.',
  systemPrompt: 'Summarize it.', agentId: agent.id, requiredToolIds: ['web_fetch'],
}
const configuration = {
  version: 1 as const,
  revision: 4,
  agents: [agent],
  skills: [skill],
  customTools: [],
  globallyEnabledToolIds: ['web_fetch'],
}

describe('agent HTTP protocol', () => {
  it('publishes strict secret-free configuration with compare-and-swap', () => {
    expect(agentConfigurationPublishRequestSchema.parse({ baseRevision: 3, configuration })).toEqual({
      baseRevision: 3,
      configuration,
    })
    expect(agentConfigurationResponseSchema.parse({ configuration, publishedAt: '2026-08-31T10:00:00.000Z' }).configuration.revision).toBe(4)
    expect(() => agentConfigurationPublishRequestSchema.parse({
      baseRevision: 3,
      configuration: { ...configuration, apiKey: 'sk-secret' },
    })).toThrow()
  })

  it('validates bounded ordered automation policies and dispatcher choices', () => {
    const policies = automationPolicySetSchema.parse({
      version: 1,
      revision: 2,
      enabled: true,
      policies: [{
        id: 'youtube-links',
        name: 'YouTube links',
        enabled: true,
        priority: 10,
        match: { urlTypes: ['youtube'], sourceKinds: ['share'] },
        skillIds: ['transcribe', 'summarize'],
        dispatcher: { enabled: false, allowedSkillIds: [] },
      }],
    })
    expect(policies.policies[0]?.skillIds).toEqual(['transcribe', 'summarize'])
    expect(() => automationPolicySetSchema.parse({
      ...policies,
      policies: [{ ...policies.policies[0], skillIds: ['research', 'research'] }],
    })).toThrow(/unique/i)
  })

  it('exposes sanitized credential and device authorization states', () => {
    expect(credentialMetadataSchema.parse({
      id: 'credential-1', provider: 'openai-codex', status: 'connected',
      accountLabel: 'owner@example.test', expiresAt: '2026-09-01T10:00:00.000Z',
      createdAt: '2026-08-31T10:00:00.000Z', updatedAt: '2026-08-31T10:00:00.000Z',
    }).status).toBe('connected')
    expect(deviceAuthorizationStartResponseSchema.parse({
      authorizationId: 'authorization-1',
      verificationUri: 'https://auth.openai.com/device',
      userCode: 'ABCD-EFGH',
      expiresAt: '2026-08-31T10:10:00.000Z',
      pollIntervalSeconds: 5,
    }).userCode).toBe('ABCD-EFGH')
    expect(deviceAuthorizationStatusSchema.parse({
      authorizationId: 'authorization-1', state: 'pending',
    }).state).toBe('pending')
    expect(() => credentialMetadataSchema.parse({
      id: 'credential-1', provider: 'openai', status: 'connected', apiKey: 'sk-secret',
      createdAt: '2026-08-31T10:00:00.000Z', updatedAt: '2026-08-31T10:00:00.000Z',
    })).toThrow()
  })

  it('validates manual admission without accepting provider secrets', () => {
    const request = {
      sourceNodeId: 'capture-1', targetParentId: 'capture-1', skillId: 'research',
      prompt: 'Research this capture.', configurationRevision: 4,
    }
    expect(agentRunAdmissionRequestSchema.parse(request)).toEqual(request)
    expect(agentRunAdmissionResponseSchema.parse({
      runId: 'run-1', status: 'queued', admittedAt: '2026-08-31T10:00:00.000Z',
    }).status).toBe('queued')
    expect(() => agentRunAdmissionRequestSchema.parse({ ...request, accessToken: 'secret' })).toThrow()
  })

  it('bounds run detail, activity cursors, cancellation, and linked retry', () => {
    const detail = agentRunDetailSchema.parse({
      id: 'run-1', outlineId: 'outline-1', trigger: 'manual', status: 'failed',
      skillId: 'research', configurationRevision: 4, attemptCount: 2,
      admittedAt: '2026-08-31T10:00:00.000Z', updatedAt: '2026-08-31T10:01:00.000Z',
      error: { code: 'dependency_unavailable', message: 'Transcript provider unavailable.', retryable: true },
      policyId: 'youtube-links', retryOfRunId: null, result: null,
    })
    expect(detail.error?.code).toBe('dependency_unavailable')
    expect(detail.policyId).toBe('youtube-links')
    expect(agentRunListQuerySchema.parse({ cursor: 'cursor-1', limit: '25' }).limit).toBe(25)
    expect(agentActivityPageSchema.parse({
      events: [{ id: 'event-1', sequence: 1, phase: 'complete', kind: 'status', label: 'Queued', status: 'success' }],
      nextCursor: null,
      status: 'queued',
    }).events[0]?.sequence).toBe(1)
    expect(agentRunCancelResponseSchema.parse({ runId: 'run-1', status: 'cancelled' }).status).toBe('cancelled')
    expect(agentRunRetryResponseSchema.parse({ runId: 'run-2', retryOfRunId: 'run-1', status: 'queued' }).retryOfRunId).toBe('run-1')
    expect(() => agentActivityPageSchema.parse({ events: [], nextCursor: 'x'.repeat(513), status: 'running' })).toThrow()
  })
})
