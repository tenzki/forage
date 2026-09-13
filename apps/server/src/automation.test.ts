// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { AutomationPolicySet } from '@forage/protocol'
import { matchAutomationPolicies, resolveAutomationMatches, runBoundedDispatcher } from './automation'

const policies: AutomationPolicySet = {
  version: 1,
  revision: 4,
  enabled: true,
  policies: [
    { id: 'web', name: 'Web', enabled: true, priority: 1, match: { urlTypes: ['webpage'] }, skillIds: ['research', 'shared'], dispatcher: { enabled: false, allowedSkillIds: [] } },
    { id: 'youtube', name: 'YouTube', enabled: true, priority: 20, match: { urlTypes: ['youtube'], sourceEquals: { app: 'shortcuts' } }, skillIds: ['transcribe', 'shared'], dispatcher: { enabled: false, allowedSkillIds: [] } },
    { id: 'host', name: 'Host', enabled: true, priority: 10, match: { urlHosts: ['www.youtube.com'] }, skillIds: ['shared', 'document'], dispatcher: { enabled: false, allowedSkillIds: [] } },
    { id: 'disabled', name: 'Disabled', enabled: false, priority: 100, match: { urlTypes: ['youtube'] }, skillIds: ['never'], dispatcher: { enabled: false, allowedSkillIds: [] } },
  ],
}

describe('Inbox automation policy matching', () => {
  it('admits only the first matching policy in priority order and de-duplicates its skills', () => {
    expect(matchAutomationPolicies(policies, {
      source: { app: 'shortcuts', kind: 'share' },
      urls: [{ type: 'youtube', host: 'www.youtube.com' }],
    })).toEqual([
      { skillId: 'transcribe', policyId: 'youtube' },
      { skillId: 'shared', policyId: 'youtube' },
    ])
  })

  it('skips a disabled or non-matching higher policy and falls through to the next match', () => {
    expect(matchAutomationPolicies(policies, {
      source: { app: 'other' },
      urls: [{ type: 'youtube', host: 'www.youtube.com' }],
    })).toEqual([
      { skillId: 'shared', policyId: 'host' },
      { skillId: 'document', policyId: 'host' },
    ])
  })

  it('matches a site domain and its subdomains but not look-alike hosts', () => {
    const set: AutomationPolicySet = { ...policies, policies: [
      { id: 'github', name: 'GitHub', enabled: true, priority: 2, match: { urlHosts: ['github.com'] }, skillIds: ['document-repo'], dispatcher: { enabled: false, allowedSkillIds: [] } },
      { id: 'any', name: 'Any link', enabled: true, priority: 1, match: { urlTypes: ['youtube', 'x', 'webpage'] }, skillIds: ['research'], dispatcher: { enabled: false, allowedSkillIds: [] } },
    ] }
    const skillFor = (host: string) => matchAutomationPolicies(set, { source: {}, urls: [{ type: 'webpage', host }] })
    expect(skillFor('github.com')).toEqual([{ skillId: 'document-repo', policyId: 'github' }])
    expect(skillFor('www.github.com')).toEqual([{ skillId: 'document-repo', policyId: 'github' }])
    expect(skillFor('gist.github.com')).toEqual([{ skillId: 'document-repo', policyId: 'github' }])
    expect(skillFor('github.community')).toEqual([{ skillId: 'research', policyId: 'any' }])
    expect(skillFor('notgithub.com')).toEqual([{ skillId: 'research', policyId: 'any' }])
  })

  it('matches source kind and source equality using conjunctive predicates', () => {
    const set: AutomationPolicySet = { ...policies, policies: [{
      id: 'share', name: 'Share', enabled: true, priority: 0,
      match: { sourceKinds: ['share'], sourceEquals: { app: 'shortcuts' } },
      skillIds: ['research'], dispatcher: { enabled: false, allowedSkillIds: [] },
    }] }
    expect(matchAutomationPolicies(set, { source: { kind: 'share', app: 'shortcuts' }, urls: [] })).toHaveLength(1)
    expect(matchAutomationPolicies(set, { source: { kind: 'share', app: 'other' }, urls: [] })).toHaveLength(0)
  })

  it('returns no work when the policy set is absent or globally disabled', () => {
    expect(matchAutomationPolicies(null, { source: {}, urls: [] })).toEqual([])
    expect(matchAutomationPolicies({ ...policies, enabled: false }, { source: {}, urls: [] })).toEqual([])
  })

  it('bounds dispatcher output to configured skill identifiers', async () => {
    await expect(runBoundedDispatcher(
      { classify: async () => ['research', 'invented', 'research'] },
      { text: 'mixed capture', source: {}, allowedSkillIds: ['research', 'document'] },
      new AbortController().signal,
    )).resolves.toEqual(['research'])
  })

  it('uses a dispatcher only for explicitly configured policies and stops at that first match', async () => {
    const classify = async () => ['document', 'invented', 'shared', 'document']
    const set: AutomationPolicySet = { ...policies, policies: [{
      id: 'ambiguous', name: 'Ambiguous', enabled: true, priority: 30,
      match: { sourceKinds: ['share'] }, skillIds: ['document', 'shared'],
      dispatcher: { enabled: true, agentId: 'classifier', allowedSkillIds: ['document', 'shared'] },
    }, policies.policies[0]!] }
    await expect(resolveAutomationMatches(
      set, { source: { kind: 'share' }, urls: [{ type: 'webpage', host: 'example.com' }] },
      { text: 'mixed', source: { kind: 'share' } }, { classify }, new AbortController().signal,
    )).resolves.toEqual([
      { skillId: 'document', policyId: 'ambiguous' },
      { skillId: 'shared', policyId: 'ambiguous' },
    ])
    await expect(resolveAutomationMatches(
      set, { source: { kind: 'share' }, urls: [{ type: 'webpage', host: 'example.com' }] },
      { text: 'mixed', source: { kind: 'share' } }, { classify: async () => [] }, new AbortController().signal,
    )).resolves.toEqual([])
    expect(matchAutomationPolicies(set, { source: { kind: 'share' }, urls: [{ type: 'webpage', host: 'example.com' }] })).toEqual([])
  })
})
