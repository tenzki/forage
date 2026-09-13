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
  const policy = firstMatchingPolicy(set, facts)
  if (!policy || policy.dispatcher.enabled) return []
  return uniqueMatches(policy.id, policy.skillIds)
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
  const policy = firstMatchingPolicy(set, facts)
  if (!policy) return []
  if (!policy.dispatcher.enabled) return uniqueMatches(policy.id, policy.skillIds)
  const classifier = policy.dispatcher.agentId && typeof dispatcher === 'function'
    ? await dispatcher(policy.dispatcher.agentId)
    : typeof dispatcher === 'object' ? dispatcher : undefined
  if (!classifier) return []
  return uniqueMatches(policy.id, await runBoundedDispatcher(classifier, {
    text: capture.text, source: capture.source,
    allowedSkillIds: policy.dispatcher.allowedSkillIds,
  }, signal))
}

// Rules are checked in priority order and only the first enabled match runs.
function firstMatchingPolicy(set: AutomationPolicySet, facts: CaptureFacts): AutomationPolicySet['policies'][number] | undefined {
  return set.policies
    .map((policy, index) => ({ policy, index }))
    .sort((left, right) => right.policy.priority - left.policy.priority || left.index - right.index)
    .find(({ policy }) => policy.enabled && matchesPolicy(policy.match, facts))
    ?.policy
}

function uniqueMatches(policyId: string, skillIds: string[]): AutomationMatch[] {
  return [...new Set(skillIds)].map((skillId) => ({ skillId, policyId }))
}

function hostMatchesDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
}

function matchesPolicy(match: AutomationPolicySet['policies'][number]['match'], facts: CaptureFacts): boolean {
  if (match.sourceKinds && !match.sourceKinds.includes(facts.source.kind ?? facts.source.sourceKind ?? '')) return false
  if (match.sourceEquals && Object.entries(match.sourceEquals).some(([key, value]) => facts.source[key] !== value)) return false
  if (match.urlTypes && !facts.urls.some((url) => match.urlTypes!.includes(url.type))) return false
  if (match.urlHosts && !facts.urls.some((url) => match.urlHosts!.some((domain) => hostMatchesDomain(url.host.toLowerCase(), domain)))) return false
  return true
}
