import { create } from 'zustand'
import { load } from '@tauri-apps/plugin-store'
import { invoke } from '@tauri-apps/api/core'
import {
  mcpConnectionAvailable, mcpConnectionSchema, mcpImportSchema, mcpInventorySchema, mcpServerConfigSchema, retainMcpToolIds,
  type McpOAuthProgress,
  type McpConnection, type McpDiscovery, type McpRunConnection, type McpServerConfig, type McpSnapshot,
} from '@forage/agent-runtime'
import { nativeLocalCredentialVault } from '../agent/localCredentials'
import { discoverLocalMcp, resolveLocalMcpCandidate, scanLocalMcp } from '../agent/mcpManagementClient'
import { useSettingsStore } from './settingsStore'
import { authorizeLocalMcp, cancelMcpAuthorization, invalidateMcpAuthorization, onMcpSignInRequired, onMcpAuthorizationAllowed, resolveMcpManagementAccessToken } from '../agent/mcpOAuthClient'

const reference = (id: string) => `forage-mcp/${id}/configuration`
export interface McpStoreDependencies {
  read: () => Promise<unknown>
  write: (connections: McpConnection[]) => Promise<void>
  vault: typeof nativeLocalCredentialVault
  discover: typeof discoverLocalMcp
  deauthorize: (ids: string[]) => Promise<void>
  serverInventory: () => Promise<unknown>
  scan: typeof scanLocalMcp
  resolveCandidate: typeof resolveLocalMcpCandidate
  authorize?: typeof authorizeLocalMcp
  invalidateAuthorization?: typeof invalidateMcpAuthorization
}
const defaults: McpStoreDependencies = {
  read: async () => (await load('mcp-connections.json', { autoSave: false })).get('connections'),
  write: async (connections) => {
    const store = await load('mcp-connections.json', { autoSave: false })
    await store.set('connections', connections)
    await store.save()
  },
  vault: nativeLocalCredentialVault,
  discover: async (id, name, config) => discoverLocalMcp(id, name, config,
    'url' in config && config.authentication?.method === 'oauth' ? await resolveMcpManagementAccessToken(id, config.url, useMcpStore.getState().connections.find((connection) => connection.id === id)?.authorizationRevision) : undefined),
  authorize: authorizeLocalMcp,
  invalidateAuthorization: invalidateMcpAuthorization,
  deauthorize: async (ids) => {
    for (const id of ids) await useSettingsStore.getState().setToolEnabled(id, false)
  },
  serverInventory: () => invoke('server_mcp_inventory'),
  scan: scanLocalMcp,
  resolveCandidate: resolveLocalMcpCandidate,
}

interface McpState {
  connections: McpConnection[]
  serverConnections: McpConnection[]
  loaded: boolean
  busy: boolean
  error: string | null
  authorizationProgress: McpOAuthProgress | null
  signIn: (id: string) => Promise<McpConnection>
  reviewAccess: (id: string) => Promise<void>
  requireSignIn: (id: string, revision?: string) => Promise<void>
  cancelAuthorization: () => Promise<void>
  discovery: McpDiscovery | null
  scanning: boolean
  discoveryError: string | null
  scanConnections: () => Promise<void>
  connectCandidate: (id: string, values: Record<string, string>, name: string) => Promise<McpConnection>
  load: () => Promise<void>
  addConnection: (name: string, config: McpServerConfig) => Promise<McpConnection>
  importConnections: (json: string) => Promise<McpConnection[]>
  refresh: (id: string) => Promise<void>
  setEnabled: (id: string, enabled: boolean) => Promise<void>
  remove: (id: string) => Promise<void>
  loadServer: () => Promise<void>
  resolve: (snapshot: McpSnapshot) => Promise<McpRunConnection[]>
}

export function createMcpStore(dependencies: McpStoreDependencies = defaults) {
  let queue: Promise<unknown> = Promise.resolve()
  return create<McpState>((set, get) => {
    const save = async (connections: McpConnection[]) => {
      await dependencies.write(mcpInventorySchema.parse(connections))
      set({ connections })
    }
    const perform = <T>(action: () => Promise<T>): Promise<T> => {
      const run = queue.then(async () => {
        set({ busy: true, error: null })
        try { return await action() }
        catch (error) { set({ error: error instanceof Error ? error.message : 'MCP operation failed.' }); throw error }
        finally { set({ busy: false }) }
      })
      queue = run.catch(() => undefined)
      return run
    }
    const configFor = async (id: string): Promise<McpServerConfig> => mcpServerConfigSchema.parse(JSON.parse(await dependencies.vault.load(reference(id))))
    const ensureLoaded = async () => {
      if (get().loaded) return
      const connections = mcpInventorySchema.parse(await dependencies.read() ?? [])
      if (connections.some((connection) => connection.environment !== 'local')) throw new Error('Invalid local MCP inventory.')
      set({ connections, loaded: true })
    }
    const connect = async (name: string, config: McpServerConfig, discoveryId?: string) => {
      if (get().connections.some((connection) => connection.name === name)) throw new Error(`A connection named ${name} already exists. Remove it before replacing its configuration.`)
      const serialized = JSON.stringify(config)
      if (new TextEncoder().encode(serialized).length > 100_000) throw new Error('MCP configuration exceeds the size limit.')
      const id = crypto.randomUUID()
      const oauth = 'url' in config && config.authentication?.method === 'oauth'
      if (oauth && !dependencies.authorize) throw new Error('MCP: Browser sign-in is unavailable.')
      const connection = { ...await (oauth ? dependencies.authorize!(id, name, config, (authorizationProgress) => set({ authorizationProgress })) : dependencies.discover(id, name, config)), ...(oauth ? { authorizationRevision: crypto.randomUUID() } : {}),
        ...('url' in config && config.authentication ? { authentication: config.authentication.method } : {}), ...(discoveryId ? { discoveryId } : {}) }
      if (!oauth) await dependencies.vault.store(reference(id), serialized)
      try { await save([...get().connections, connection]) }
      catch (error) {
        if (oauth) await dependencies.invalidateAuthorization?.(id).catch(() => undefined)
        else await dependencies.vault.remove(reference(id)).catch(() => undefined)
        throw error
      }
      return connection
    }
    return {
      connections: [], serverConnections: [], loaded: false, busy: false, error: null, authorizationProgress: null,
      cancelAuthorization: async () => { await cancelMcpAuthorization(); set({ authorizationProgress: null }) },
      requireSignIn: (id, revision) => perform(async () => {
        await save(get().connections.map((connection) => connection.id === id && connection.authentication === 'oauth' && (!revision || connection.authorizationRevision === revision)
          ? { ...connection, authorizationStatus: 'sign_in_required' } : connection))
      }),
      reviewAccess: (id) => perform(async () => {
        await save(get().connections.map((connection) => connection.id === id && connection.authorizationStatus === 'review_required'
          ? { ...connection, authorizationStatus: 'connected' } : connection))
      }),
      signIn: (id) => perform(async () => {
        const previous = get().connections.find((connection) => connection.id === id)
        if (!previous || previous.authentication !== 'oauth' || !dependencies.authorize) throw new Error('MCP: Browser sign-in is unavailable.')
        await save(get().connections.map((connection) => connection.id === id ? { ...connection, authorizationStatus: 'sign_in_required' } : connection))
        const next = retainMcpToolIds(previous, await dependencies.authorize(id, previous.name, await configFor(id), (authorizationProgress) => set({ authorizationProgress })))
        const changed = previous.tools.filter((tool) => !next.tools.some((candidate) => candidate.id === tool.id))
        await dependencies.deauthorize(changed.map((tool) => tool.id))
        const connection: McpConnection = { ...next, enabled: previous.enabled, authentication: 'oauth', authorizationStatus: 'review_required', authorizationRevision: crypto.randomUUID(), ...(previous.discoveryId ? { discoveryId: previous.discoveryId } : {}) }
        await save(get().connections.map((before) => before.id === id ? connection : before))
        return connection
      }),
      discovery: null, scanning: false, discoveryError: null,
      scanConnections: async () => {
        if (get().scanning) return
        set({ scanning: true, discoveryError: null, discovery: null })
        try { set({ discovery: await dependencies.scan() }) }
        catch (error) { set({ discoveryError: error instanceof Error ? error.message : 'Could not look for MCP connections.' }); throw error }
        finally { set({ scanning: false }) }
      },
      connectCandidate: (id, values, name) => perform(async () => {
        await ensureLoaded()
        if (get().connections.some((connection) => connection.discoveryId === id)) throw new Error('This connection is already imported.')
        if (get().connections.length >= 32) throw new Error('At most 32 MCP connections are supported.')
        const parsedName = mcpConnectionSchema.shape.name.safeParse(name)
        if (!parsedName.success) throw new Error('Enter a server name of up to 80 characters.')
        const { config } = await dependencies.resolveCandidate(id, values)
        return connect(parsedName.data, mcpServerConfigSchema.parse(config), id)
      }),
      load: () => perform(async () => {
        const connections = mcpInventorySchema.parse(await dependencies.read() ?? [])
        if (connections.some((connection) => connection.environment !== 'local')) throw new Error('Invalid local MCP inventory.')
        set({ connections, loaded: true })
      }),
      addConnection: (name, config) => perform(async () => {
        const parsedName = mcpConnectionSchema.shape.name.safeParse(name)
        if (!parsedName.success) throw new Error('Enter a server name of up to 80 characters.')
        const parsedConfig = mcpServerConfigSchema.safeParse(config)
        if (!parsedConfig.success) throw new Error('Check the server URL, command, and credential fields. Remote URLs require HTTPS; localhost may use HTTP.')
        await ensureLoaded()
        if (get().connections.length >= 32) throw new Error('At most 32 MCP connections are supported.')
        return connect(parsedName.data, parsedConfig.data)
      }),
      importConnections: (json) => perform(async () => {
        if (json.length > 100_000) throw new Error('MCP configuration exceeds the size limit.')
        let imported: ReturnType<typeof mcpImportSchema.parse>
        try { imported = mcpImportSchema.parse(JSON.parse(json)) }
        catch { throw new Error('Enter mcpServers JSON with command/args/env or url/headers. Remote URLs require HTTPS; localhost may use HTTP.') }
        await ensureLoaded()
        if (get().connections.length + Object.keys(imported.mcpServers).length > 32) throw new Error('At most 32 MCP connections are supported.')
        const connected: McpConnection[] = []
        for (const [name, config] of Object.entries(imported.mcpServers)) connected.push(await connect(name, config))
        return connected
      }),
      refresh: (id) => perform(async () => {
        const previous = get().connections.find((connection) => connection.id === id)
        if (!previous) throw new Error('MCP connection no longer exists.')
        try {
          const next = retainMcpToolIds(previous, await dependencies.discover(id, previous.name, await configFor(id)))
          const changedIds = previous.tools.filter((tool) => !next.tools.some((candidate) => candidate.id === tool.id)).map((tool) => tool.id)
          await dependencies.deauthorize(changedIds)
          await save(get().connections.map((connection) => connection.id === id ? { ...next, enabled: previous.enabled,
            ...(previous.authentication ? { authentication: previous.authentication } : {}), ...(previous.authorizationStatus ? { authorizationStatus: previous.authorizationStatus } : {}), ...(previous.authorizationRevision ? { authorizationRevision: previous.authorizationRevision } : {}),
            ...(previous.discoveryId ? { discoveryId: previous.discoveryId } : {}) } : connection))
        } catch (error) {
          await save(get().connections.map((connection) => connection.id === id ? { ...connection, error: 'Connection unavailable. Refresh to reconnect.' } : connection))
          throw error
        }
      }),
      setEnabled: (id, enabled) => perform(async () => {
        await save(get().connections.map((connection) => connection.id === id ? { ...connection, enabled } : connection))
      }),
      remove: (id) => perform(async () => {
        if (get().connections.find((connection) => connection.id === id)?.authentication === 'oauth') await dependencies.invalidateAuthorization?.(id)
        await dependencies.deauthorize(get().connections.find((connection) => connection.id === id)?.tools.map((tool) => tool.id) ?? [])
        await save(get().connections.filter((connection) => connection.id !== id))
        await dependencies.vault.remove(reference(id))
      }),
      loadServer: () => perform(async () => {
        // Clear first: a disconnected or changed backend must not retain an old catalog.
        set({ serverConnections: [] })
        const connections = mcpInventorySchema.parse(await dependencies.serverInventory())
        if (connections.some((connection) => connection.environment !== 'server')) throw new Error('Invalid backend MCP inventory.')
        set({ serverConnections: connections })
      }),
      resolve: async (snapshot) => {
        const output: McpRunConnection[] = []
        for (const admitted of snapshot) {
          const current = get().connections.find((connection) => connection.id === admitted.id)
          if (!current || !mcpConnectionAvailable(current) || admitted.environment !== 'local'
            || admitted.authorizationRevision && admitted.authorizationRevision !== current.authorizationRevision
            || admitted.tools.some((tool) => !current.tools.some((candidate) => candidate.id === tool.id && candidate.remoteName === tool.remoteName
              && (!tool.bindingFingerprint || candidate.bindingFingerprint === tool.bindingFingerprint)))) {
            throw new Error('MCP connection changed or is disabled. Refresh it before retrying.')
          }
          output.push({ connection: admitted, config: await configFor(admitted.id) })
        }
        return output
      },
    }
  })
}

export const useMcpStore = createMcpStore()
onMcpSignInRequired((id, revision) => useMcpStore.getState().requireSignIn(id, revision))
onMcpAuthorizationAllowed((id, revision) => {
  const connection = useMcpStore.getState().connections.find((entry) => entry.id === id)
  return !!connection && mcpConnectionAvailable(connection) && (!revision || revision === connection.authorizationRevision)
})

export function mcpToolOptions(connections: readonly McpConnection[]) {
  return connections.flatMap((connection) => connection.tools.map((tool) => ({
    id: tool.id, name: `${connection.name} · ${tool.name}`, description: tool.description,
    sourceName: connection.name, environment: connection.environment,
    available: mcpConnectionAvailable(connection),
    unavailableReason: connection.authorizationStatus === 'sign_in_required' ? 'Sign in required' : connection.authorizationStatus === 'review_required' ? 'Review access required' : connection.error ?? (connection.enabled ? undefined : 'Connection disabled'),
  })))
}
