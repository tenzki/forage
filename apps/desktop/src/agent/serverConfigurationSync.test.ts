import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PortableAgentConfiguration } from '@forage/agent-runtime'
import { useSettingsStore } from '../store/settingsStore'
import { buildServerAgentConfiguration } from './serverConfiguration'
import { confirmedConfigurationMirror, type ConfigurationMirror } from './configurationMirror'
import {
  publishLocalAgentConfiguration,
  republishLocalAgentConfiguration,
  usePublishedServerConfiguration,
} from './serverConfigurationSync'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

const connection = { origin: 'https://forage.example', instanceId: 'server-1', outlineId: 'outline-1' }
const agent = { id: 'agent', name: 'Agent', description: 'Agent', systemPrompt: 'Help.', toolIds: [] }
const research = { id: 'research', label: 'research', description: 'Research', systemPrompt: 'Research.', agentId: 'agent', requiredToolIds: [] }
const inbox = { id: 'research-inbox', label: 'research-inbox', description: 'Inbox', systemPrompt: 'Read.', agentId: 'agent', requiredToolIds: [] }

function localSettings(skills: typeof research[]) {
  return { agents: [agent], skills, customTools: [], enabledToolIds: [], modelId: 'gpt-5.5' }
}

function serverConfiguration(skills: typeof research[], revision: number): PortableAgentConfiguration {
  return buildServerAgentConfiguration(localSettings(skills), revision)
}

function fakeServer(initial: PortableAgentConfiguration, mirror: ConfigurationMirror | null) {
  let current = initial
  let savedMirror = mirror
  const transport = {
    configuration: vi.fn(async () => ({ configuration: current })),
    publishConfiguration: vi.fn(async (request: unknown) => {
      const { baseRevision, configuration } = request as { baseRevision: number; configuration: PortableAgentConfiguration }
      if (baseRevision !== current.revision) throw new Error('Agent configuration revision conflict.')
      current = configuration
      return { configuration }
    }),
  }
  const mirrorStore = {
    load: vi.fn(async () => savedMirror),
    save: vi.fn(async (next: ConfigurationMirror) => { savedMirror = next }),
  }
  return { transport, mirrorStore, current: () => current, connection: async () => connection }
}

describe('server agent configuration sync', () => {
  beforeEach(() => {
    usePublishedServerConfiguration.setState({ configuration: null })
    useSettingsStore.setState(localSettings([research]))
  })

  it('does nothing on a local-only device', async () => {
    const server = fakeServer(serverConfiguration([research], 3), null)

    await expect(publishLocalAgentConfiguration({ ...server, connection: async () => null })).resolves.toBe('local_only')

    expect(server.transport.configuration).not.toHaveBeenCalled()
  })

  it('publishes a locally saved skill and shares the new server configuration', async () => {
    const published = serverConfiguration([research], 3)
    const server = fakeServer(published, await confirmedConfigurationMirror(published))
    useSettingsStore.setState({ skills: [research, inbox] })

    await expect(publishLocalAgentConfiguration(server)).resolves.toBe('published')

    expect(server.current().revision).toBe(4)
    expect(server.current().skills.map((skill) => skill.id)).toEqual(['research', 'research-inbox'])
    expect(server.mirrorStore.save).toHaveBeenCalledWith(expect.objectContaining({ serverRevision: 4 }))
    expect(usePublishedServerConfiguration.getState().configuration?.skills.map((skill) => skill.id)).toContain('research-inbox')
  })

  it('refuses to overwrite agent settings another device published', async () => {
    const confirmed = serverConfiguration([research], 3)
    const server = fakeServer(serverConfiguration([], 4), await confirmedConfigurationMirror(confirmed))
    useSettingsStore.setState({ skills: [research, inbox] })

    await expect(publishLocalAgentConfiguration(server)).rejects.toThrow(/changed on the server/)

    expect(server.transport.publishConfiguration).not.toHaveBeenCalled()
  })

  it('serializes overlapping publishes instead of racing on the same revision', async () => {
    const published = serverConfiguration([research], 3)
    const server = fakeServer(published, await confirmedConfigurationMirror(published))
    useSettingsStore.setState({ skills: [research, inbox] })

    await expect(Promise.all([
      publishLocalAgentConfiguration(server),
      publishLocalAgentConfiguration(server),
    ])).resolves.toEqual(['published', 'unchanged'])

    expect(server.current().revision).toBe(4)
  })

  it('republishes this device over the server revision and records the mirror', async () => {
    const server = fakeServer(serverConfiguration([], 4), null)
    useSettingsStore.setState({ skills: [research, inbox] })

    await republishLocalAgentConfiguration(server)

    expect(server.current().revision).toBe(5)
    expect(server.mirrorStore.save).toHaveBeenCalledWith(expect.objectContaining({ serverRevision: 5 }))
    expect(usePublishedServerConfiguration.getState().configuration?.revision).toBe(5)
  })

  it('never replaces a newer published configuration with an older response', () => {
    const { accept } = usePublishedServerConfiguration.getState()
    accept(serverConfiguration([research, inbox], 4))
    accept(serverConfiguration([research], 3))

    expect(usePublishedServerConfiguration.getState().configuration?.revision).toBe(4)
  })
})
