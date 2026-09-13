import { describe, expect, it } from 'vitest'
import { firstIncompleteProvisioningStep, parseServerProvisioningState } from './serverProvisioning'

describe('server provisioning state', () => {
  it('resumes at the first incomplete step', () => {
    const state = parseServerProvisioningState({
      version: 1, instanceId: 'server', outlineId: 'outline', computeSkipped: false,
      completed: { connection: '2026-09-13T10:00:00Z', outline: '2026-09-13T10:00:01Z' },
    })!
    expect(firstIncompleteProvisioningStep(state)).toBe('synchronization')
  })

  it('treats an explicit sync-only choice as complete', () => {
    const state = parseServerProvisioningState({
      version: 1, instanceId: 'server', outlineId: 'outline', computeSkipped: true,
      completed: Object.fromEntries(['connection', 'outline', 'synchronization', 'configuration', 'mirror'].map((step) => [step, 'now'])),
    })!
    expect(firstIncompleteProvisioningStep(state)).toBeNull()
  })
})
