import { invoke } from '@tauri-apps/api/core'
import { canonicalJson, sha256Hex } from '@forage/domain'
import {
  migrateAgentConfiguration,
  portableAgentConfigurationSchema,
  supportedAgentConfigurationSchema,
  type PortableAgentConfiguration,
  type SupportedAgentConfiguration,
} from '@forage/agent-runtime'

export interface ConfigurationMirror {
  version: 1
  serverRevision: number
  canonicalHash: string
  configuration: PortableAgentConfiguration
  confirmedAt: string
}

export type ConfigurationReconciliation =
  | { outcome: 'unchanged'; server: PortableAgentConfiguration }
  | { outcome: 'publish_local'; server: PortableAgentConfiguration }
  | { outcome: 'use_server'; server: PortableAgentConfiguration }
  | { outcome: 'conflict'; server: PortableAgentConfiguration }

export interface ConfigurationMirrorStore {
  load(): Promise<ConfigurationMirror | null>
  save(mirror: ConfigurationMirror): Promise<void>
}

export class NativeConfigurationMirrorStore implements ConfigurationMirrorStore {
  async load(): Promise<ConfigurationMirror | null> {
    const value = await invoke<unknown | null>('server_agent_configuration_mirror')
    if (!value) return null
    const candidate = value as Partial<ConfigurationMirror>
    if (candidate.version !== 1 || typeof candidate.serverRevision !== 'number'
      || typeof candidate.canonicalHash !== 'string' || typeof candidate.confirmedAt !== 'string') return null
    const parsed = supportedAgentConfigurationSchema.parse(candidate.configuration)
    const configuration = migrateAgentConfiguration(parsed).configuration
    return {
      ...candidate,
      canonicalHash: parsed.version === 3
        ? candidate.canonicalHash
        : await portableConfigurationHash(configuration),
      configuration,
    } as ConfigurationMirror
  }

  async save(mirror: ConfigurationMirror): Promise<void> {
    await invoke('server_agent_set_configuration_mirror', { mirror })
  }
}

export async function portableConfigurationHash(configuration: SupportedAgentConfiguration): Promise<string> {
  const current = migrateAgentConfiguration(supportedAgentConfigurationSchema.parse(configuration)).configuration
  const { revision: _revision, ...portable } = portableAgentConfigurationSchema.parse(current)
  return sha256Hex(canonicalJson(portable))
}

export async function confirmedConfigurationMirror(configuration: PortableAgentConfiguration): Promise<ConfigurationMirror> {
  const parsed = portableAgentConfigurationSchema.parse(configuration)
  return {
    version: 1,
    serverRevision: parsed.revision,
    canonicalHash: await portableConfigurationHash(parsed),
    configuration: parsed,
    confirmedAt: new Date().toISOString(),
  }
}

export async function reconcileConfiguration(
  local: PortableAgentConfiguration,
  server: PortableAgentConfiguration,
  base: ConfigurationMirror | null,
): Promise<ConfigurationReconciliation> {
  const [localHash, serverHash] = await Promise.all([
    portableConfigurationHash(local), portableConfigurationHash(server),
  ])
  if (!base) return localHash === serverHash ? { outcome: 'unchanged', server } : { outcome: 'conflict', server }
  const localChanged = localHash !== base.canonicalHash
  const serverChanged = serverHash !== base.canonicalHash || server.revision !== base.serverRevision
  if (!localChanged && !serverChanged) return { outcome: 'unchanged', server }
  if (localChanged && !serverChanged) return { outcome: 'publish_local', server }
  if (!localChanged && serverChanged) return { outcome: 'use_server', server }
  return { outcome: 'conflict', server }
}
