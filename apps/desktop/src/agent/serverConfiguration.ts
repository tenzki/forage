import type { PortableAgentConfiguration } from '@forage/agent-runtime'
import type { AgentDefinition, SkillDefinition } from './definitions'
import type { CustomHttpToolConfig } from './tools'
import { normalizeCustomToolReferences } from './runtimeToolReferences'

export interface LocalAgentConfiguration {
  agents: AgentDefinition[]
  skills: SkillDefinition[]
  customTools: CustomHttpToolConfig[]
  enabledToolIds: string[]
  modelId: string
}

export interface ServerConfigurationTransport {
  configuration(): Promise<{ configuration: PortableAgentConfiguration }>
  publishConfiguration(request: unknown): Promise<{ configuration: PortableAgentConfiguration }>
}

export function isMissingServerAgentConfiguration(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error)
  return /no server agent configuration has been published|agent configuration.*not published|not published/i.test(detail)
}

export function buildServerAgentConfiguration(
  settings: LocalAgentConfiguration,
  revision: number,
  _credentialRef?: string,
): PortableAgentConfiguration {
  const { customTools, normalizeToolIds } = normalizeCustomToolReferences(settings.customTools)
  return {
    version: 3,
    revision,
    agents: settings.agents.map((agent) => ({
      id: agent.id, name: agent.name, description: agent.description, systemPrompt: agent.systemPrompt,
      toolIds: normalizeToolIds(agent.toolIds),
    })),
    skills: settings.skills.map((skill) => (
      'execution' in skill && skill.execution === 'extension'
        ? skill
        : { ...skill, execution: 'llm' as const, requiredToolIds: normalizeToolIds(skill.requiredToolIds) }
    )),
    customTools,
    globallyEnabledToolIds: normalizeToolIds(settings.enabledToolIds),
  }
}

export async function ensureServerAgentConfiguration(
  transport: ServerConfigurationTransport,
  settings: LocalAgentConfiguration,
): Promise<{ configuration: PortableAgentConfiguration }> {
  try {
    return await transport.configuration()
  } catch (error) {
    if (!isMissingServerAgentConfiguration(error)) throw error
  }

  try {
    return await transport.publishConfiguration({
      baseRevision: 0,
      configuration: buildServerAgentConfiguration(settings, 1),
    })
  } catch (error) {
    if (!/agent configuration revision conflict/i.test(error instanceof Error ? error.message : String(error))) throw error
    return transport.configuration()
  }
}

export async function synchronizeServerAgentConfiguration(
  transport: ServerConfigurationTransport,
  settings: LocalAgentConfiguration,
  credentialRef?: string,
): Promise<{ configuration: PortableAgentConfiguration }> {
  let current: { configuration: PortableAgentConfiguration } | null = null
  try {
    current = await transport.configuration()
  } catch (error) {
    if (!isMissingServerAgentConfiguration(error)) throw error
  }
  const baseRevision = current?.configuration.revision ?? 0
  return transport.publishConfiguration({
    baseRevision,
    configuration: buildServerAgentConfiguration(settings, baseRevision + 1, credentialRef),
  })
}
