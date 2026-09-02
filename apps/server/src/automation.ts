import { automationPolicySetSchema, type AutomationPolicySet } from '@forage/protocol'
import type { PublicSourceType } from './sourceUrl.js'
import { classifySourceUrl } from './sourceUrl.js'

export interface CaptureFacts {
  source: Record<string, string>
  urls: Array<{ type: PublicSourceType; host: string }>
}

export function captureFacts(text: string, source: Record<string, string> = {}): CaptureFacts {
  const candidates = new Set<string>()
  const add = (value: string): void => {
    for (const match of value.matchAll(/https?:\/\/[^\s<>"']+/gi)) candidates.add(match[0]!.replace(/[),.;!?]+$/, ''))
    if (/^https?:\/\//i.test(value.trim())) candidates.add(value.trim())
  }
  add(text)
  Object.values(source).forEach(add)
  const urls: CaptureFacts['urls'] = []
  for (const candidate of candidates) {
    try {
      const inspected = classifySourceUrl(candidate)
      urls.push({ type: inspected.type, host: inspected.host })
    } catch { /* malformed URLs do not match */ }
  }
  return { source, urls }
}

export interface AutomationMatch { skillId: string; policyId: string }

export interface DispatcherClassifier {
  classify(input: { text: string; source: Record<string, string>; allowedSkillIds: string[] }, signal: AbortSignal): Promise<string[]>
}

export async function runBoundedDispatcher(
  classifier: DispatcherClassifier,
  input: { text: string; source: Record<string, string>; allowedSkillIds: string[] },
  signal: AbortSignal,
): Promise<string[]> {
  if (input.text.length > 100_000 || input.allowedSkillIds.length > 20) throw new Error('Dispatcher input exceeds bounds.')
  const allowed = new Set(input.allowedSkillIds)
  const selected = await classifier.classify({
    text: input.text, source: structuredClone(input.source), allowedSkillIds: [...input.allowedSkillIds],
  }, signal)
  if (!Array.isArray(selected) || selected.length > 20) throw new Error('Dispatcher output exceeds bounds.')
  return selected.filter((skillId, index) => allowed.has(skillId) && selected.indexOf(skillId) === index)
}

export function matchAutomationPolicies(rawPolicies: AutomationPolicySet | null, facts: CaptureFacts): AutomationMatch[] {
  if (!rawPolicies) return []
  const set = automationPolicySetSchema.parse(rawPolicies)
  if (!set.enabled) return []
  const seenSkills = new Set<string>()
  const matches: AutomationMatch[] = []
  for (const policy of matchingPolicies(set, facts)) {
    if (policy.dispatcher.enabled) continue
    for (const skillId of policy.skillIds) {
      if (seenSkills.has(skillId)) continue
      seenSkills.add(skillId)
      matches.push({ skillId, policyId: policy.id })
    }
  }
  return matches
}

export async function resolveAutomationMatches(
  rawPolicies: AutomationPolicySet | null,
  facts: CaptureFacts,
  capture: { text: string; source: Record<string, string> },
  dispatcher: DispatcherClassifier | ((agentId: string) => Promise<DispatcherClassifier | undefined>) | undefined,
  signal: AbortSignal,
): Promise<AutomationMatch[]> {
  if (!rawPolicies) return []
  const set = automationPolicySetSchema.parse(rawPolicies)
  if (!set.enabled) return []
  const seenSkills = new Set<string>()
  const matches: AutomationMatch[] = []
  for (const policy of matchingPolicies(set, facts)) {
    const classifier = policy.dispatcher.enabled && policy.dispatcher.agentId && typeof dispatcher === 'function'
      ? await dispatcher(policy.dispatcher.agentId)
      : typeof dispatcher === 'object' ? dispatcher : undefined
    const skillIds = policy.dispatcher.enabled
      ? classifier
        ? await runBoundedDispatcher(classifier, {
          text: capture.text, source: capture.source,
          allowedSkillIds: policy.dispatcher.allowedSkillIds,
        }, signal)
        : []
      : policy.skillIds
    for (const skillId of skillIds) {
      if (seenSkills.has(skillId)) continue
      seenSkills.add(skillId)
      matches.push({ skillId, policyId: policy.id })
    }
  }
  return matches
}

function matchingPolicies(set: AutomationPolicySet, facts: CaptureFacts): AutomationPolicySet['policies'] {
  return set.policies
    .map((policy, index) => ({ policy, index }))
    .sort((left, right) => right.policy.priority - left.policy.priority || left.index - right.index)
    .filter(({ policy }) => policy.enabled && matchesPolicy(policy.match, facts))
    .map(({ policy }) => policy)
}

function matchesPolicy(match: AutomationPolicySet['policies'][number]['match'], facts: CaptureFacts): boolean {
  if (match.sourceKinds && !match.sourceKinds.includes(facts.source.kind ?? facts.source.sourceKind ?? '')) return false
  if (match.sourceEquals && Object.entries(match.sourceEquals).some(([key, value]) => facts.source[key] !== value)) return false
  if (match.urlTypes && !facts.urls.some((url) => match.urlTypes!.includes(url.type))) return false
  if (match.urlHosts && !facts.urls.some((url) => match.urlHosts!.includes(url.host.toLowerCase()))) return false
  return true
}
