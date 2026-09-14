import { invoke } from '@tauri-apps/api/core'
import { create } from 'zustand'
import type { PortableAgentConfiguration } from '@forage/agent-runtime'
import type { ServerConnectionInfo } from '../persistence/eventStore'
import { useSettingsStore } from '../store/settingsStore'
import {
  confirmedConfigurationMirror,
  NativeConfigurationMirrorStore,
  reconcileConfiguration,
  type ConfigurationMirrorStore,
} from './configurationMirror'
import { buildServerAgentConfiguration, isMissingServerAgentConfiguration, type ServerConfigurationTransport } from './serverConfiguration'
import { TauriServerAgentTransport } from './serverExecutor'

interface PublishedServerConfigurationState {
  configuration: PortableAgentConfiguration | null
  accept: (configuration: PortableAgentConfiguration) => void
}

// The last agent configuration the server confirmed. Settings sections load and publish independently, so
// responses may arrive out of order; only a newer revision replaces what is known.
export const usePublishedServerConfiguration = create<PublishedServerConfigurationState>((set, get) => ({
  configuration: null,
  accept: (configuration) => {
    const current = get().configuration
    if (!current || configuration.revision >= current.revision) set({ configuration })
  },
}))

export interface ServerConfigurationSyncDependencies {
  transport?: ServerConfigurationTransport
  mirrorStore?: ConfigurationMirrorStore
  connection?: () => Promise<ServerConnectionInfo | null>
}

export type ServerConfigurationSyncResult = 'local_only' | 'published' | 'unchanged'

let queue: Promise<unknown> = Promise.resolve()

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task)
  queue = run.catch(() => undefined)
  return run
}

function localConfiguration(revision: number): PortableAgentConfiguration {
  const { agents, skills, customTools, enabledToolIds, modelId } = useSettingsStore.getState()
  return buildServerAgentConfiguration({ agents, skills, customTools, enabledToolIds, modelId }, revision)
}

function resolve(dependencies: ServerConfigurationSyncDependencies) {
  return {
    transport: dependencies.transport ?? new TauriServerAgentTransport(),
    mirrorStore: dependencies.mirrorStore ?? new NativeConfigurationMirrorStore(),
    connection: dependencies.connection ?? (() => invoke<ServerConnectionInfo | null>('server_connection_info')),
  }
}

/**
 * Publishes this device's agents, skills, and tools after a local change in server mode. It uses the same
 * three-way reconciliation as Settings startup, so it never overwrites changes another device published.
 */
export function publishLocalAgentConfiguration(dependencies: ServerConfigurationSyncDependencies = {}): Promise<ServerConfigurationSyncResult> {
  const { transport, mirrorStore, connection } = resolve(dependencies)
  return serialized(async () => {
    if (!await connection()) return 'local_only'
    let server: PortableAgentConfiguration
    try {
      server = (await transport.configuration()).configuration
    } catch (error) {
      // Server setup publishes the first configuration; until then there is nothing to keep in sync.
      if (isMissingServerAgentConfiguration(error)) return 'local_only'
      throw error
    }
    const local = localConfiguration(server.revision)
    const reconciliation = await reconcileConfiguration(local, server, await mirrorStore.load().catch(() => null))
    if (reconciliation.outcome === 'conflict') {
      throw new Error('Agent settings changed on the server since this device last synced. Reopen Settings to choose which version to keep.')
    }
    if (reconciliation.outcome !== 'publish_local') {
      usePublishedServerConfiguration.getState().accept(server)
      return 'unchanged'
    }
    const published = await transport.publishConfiguration({
      baseRevision: server.revision,
      configuration: { ...local, revision: server.revision + 1 },
    })
    await mirrorStore.save(await confirmedConfigurationMirror(published.configuration))
    usePublishedServerConfiguration.getState().accept(published.configuration)
    return 'published'
  })
}

/** Explicitly replaces the server configuration with this device's, as the Republish action does. */
export function republishLocalAgentConfiguration(dependencies: ServerConfigurationSyncDependencies = {}): Promise<PortableAgentConfiguration> {
  const { transport, mirrorStore } = resolve(dependencies)
  return serialized(async () => {
    let revision = 0
    try {
      revision = (await transport.configuration()).configuration.revision
    } catch (error) {
      if (!isMissingServerAgentConfiguration(error)) throw error
    }
    const published = await transport.publishConfiguration({ baseRevision: revision, configuration: localConfiguration(revision + 1) })
    await mirrorStore.save(await confirmedConfigurationMirror(published.configuration))
    usePublishedServerConfiguration.getState().accept(published.configuration)
    return published.configuration
  })
}
