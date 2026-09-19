import { create } from 'zustand'
import type {
  ExtensionCatalog,
  ExtensionCatalogEntry,
  ExtensionConfiguration,
  ExtensionSourceConfiguration,
  ExtensionSourceRequest,
} from '@forage/agent-runtime'
import { ExtensionManagementClient, type ExtensionManagementCommand } from '../agent/extensionManagementClient'

interface ExtensionManagementTransport {
  start(): Promise<void>
  request(command: ExtensionManagementCommand): Promise<import('@forage/agent-runtime').ExtensionManagementResponse>
}

let transport: ExtensionManagementTransport | null = null
let starting: Promise<ExtensionManagementTransport> | null = null

async function management(): Promise<ExtensionManagementTransport> {
  if (transport) return transport
  if (!starting) {
    const client = new ExtensionManagementClient()
    starting = client.start().then(() => {
      transport = client
      return client
    }).finally(() => { starting = null })
  }
  return starting
}

export interface ExtensionToolOption {
  id: string
  name: string
  description: string
  available: boolean
  installationId: string
  extensionId: string
  sourceName: string
  unavailableReason?: string
}

interface ExtensionState {
  catalog: ExtensionCatalog | null
  configuration: ExtensionConfiguration | null
  extensionsDirectory: string | null
  isLoaded: boolean
  isLoading: boolean
  busyInstallationId: string | null
  updateAvailability: Record<string, { available: boolean; revision?: string }>
  error: string | null
  refresh: () => Promise<void>
  installLocal: (path: string) => Promise<void>
  previewInstall: (source: ExtensionSourceRequest) => Promise<NonNullable<Extract<import('@forage/agent-runtime').ExtensionManagementResponse, { ok: true }>['preview']>>
  install: (source: ExtensionSourceRequest, previewId: string) => Promise<void>
  enable: (installationId: string) => Promise<void>
  disable: (installationId: string) => Promise<void>
  reload: (installationId: string) => Promise<void>
  checkUpdates: (installationId: string) => Promise<void>
  update: (installationId: string) => Promise<void>
  remove: (installationId: string) => Promise<void>
  configure: (
    installationId: string,
    settings: Record<string, string | number | boolean>,
    secretReferences: Record<string, string>,
  ) => Promise<void>
}

function detail(response: Awaited<ReturnType<ExtensionManagementTransport['request']>>): string {
  return response.ok ? '' : response.diagnostics.map((diagnostic) => diagnostic.message).join('\n')
}

async function request(command: ExtensionManagementCommand) {
  const response = await (await management()).request(command)
  if (!response.ok) throw new Error(detail(response))
  return response
}

export const useExtensionStore = create<ExtensionState>((set) => {
  const refresh = async () => {
    set({ isLoading: true, error: null })
    try {
      const response = await request({ operation: 'inventory' })
      if (!response.ok || !response.catalog || !response.configuration || !response.extensionsDirectory) {
        throw new Error('Extension inventory returned an incomplete response.')
      }
      set({
        catalog: response.catalog,
        configuration: response.configuration,
        extensionsDirectory: response.extensionsDirectory,
        isLoaded: true,
        isLoading: false,
        error: null,
      })
    } catch (error) {
      set({ isLoaded: true, isLoading: false, error: message(error) })
      throw error
    }
  }

  const perform = async (installationId: string | null, command: ExtensionManagementCommand) => {
    set({ busyInstallationId: installationId, error: null })
    try {
      await request(command)
      await refresh()
    } catch (error) {
      set({ error: message(error) })
      throw error
    } finally {
      set({ busyInstallationId: null })
    }
  }

  return {
    catalog: null,
    configuration: null,
    extensionsDirectory: null,
    isLoaded: false,
    isLoading: false,
    busyInstallationId: null,
    updateAvailability: {},
    error: null,
    refresh,
    installLocal: async (path) => perform(null, { operation: 'install', source: { kind: 'local', path } }),
    previewInstall: async (source) => {
      set({ busyInstallationId: 'install-preview', error: null })
      try {
        const response = await request({ operation: 'preview_install', source })
        if (!response.ok || !response.preview) throw new Error('Extension preview returned an incomplete response.')
        return response.preview
      } catch (error) {
        set({ error: message(error) })
        throw error
      } finally {
        set({ busyInstallationId: null })
      }
    },
    install: async (source, previewId) => perform(null, { operation: 'install', source, previewId }),
    enable: async (installationId) => perform(installationId, { operation: 'enable', installationId, trustAccepted: true }),
    disable: async (installationId) => perform(installationId, { operation: 'disable', installationId }),
    reload: async (installationId) => perform(installationId, { operation: 'reload', installationId }),
    checkUpdates: async (installationId) => {
      set({ busyInstallationId: installationId, error: null })
      try {
        const response = await request({ operation: 'check_updates', installationId })
        if (!response.ok || !response.update) throw new Error('Update check returned an incomplete response.')
        const updateStatus = response.update
        set((state) => ({ updateAvailability: { ...state.updateAvailability, [installationId]: updateStatus } }))
      } catch (error) {
        set({ error: message(error) })
        throw error
      } finally {
        set({ busyInstallationId: null })
      }
    },
    update: async (installationId) => {
      await perform(installationId, { operation: 'update', installationId })
      set((state) => ({ updateAvailability: { ...state.updateAvailability, [installationId]: { available: false } } }))
    },
    remove: async (installationId) => {
      await perform(installationId, { operation: 'remove', installationId })
      set((state) => {
        const updateAvailability = { ...state.updateAvailability }
        delete updateAvailability[installationId]
        return { updateAvailability }
      })
    },
    configure: async (installationId, settings, secretReferences) => perform(installationId, {
      operation: 'configure', installationId, settings, secretReferences,
    }),
  }
})

export function extensionConfigurationFor(
  state: Pick<ExtensionState, 'configuration'>,
  installationId: string,
): ExtensionSourceConfiguration | undefined {
  return state.configuration?.sources.find((source) => source.installationId === installationId)
}

export function extensionToolOptions(catalog: ExtensionCatalog | null): ExtensionToolOption[] {
  if (!catalog) return []
  return catalog.entries.flatMap((entry) => {
    const declaration = entry.manifest ?? entry.inspection
    if (!declaration) return []
    return entry.tools.map((tool) => ({
      id: tool.id,
      name: tool.name,
      description: tool.description,
      available: entry.status === 'ready' && tool.available,
      installationId: entry.source.installationId,
      extensionId: declaration.id,
      sourceName: declaration.name,
      ...(entry.status === 'ready' && tool.available ? {} : {
        unavailableReason: tool.diagnostics[0]?.message ?? statusLabel(entry),
      }),
    }))
  })
}

export function extensionAttentionCount(catalog: ExtensionCatalog | null): number {
  return catalog?.entries.filter((entry) => ['needs_review', 'needs_configuration', 'incompatible', 'error'].includes(entry.status)).length ?? 0
}

export function statusLabel(entry: ExtensionCatalogEntry): string {
  return ({
    needs_review: 'Needs review',
    disabled: 'Disabled',
    needs_configuration: 'Needs configuration',
    ready: 'Ready',
    incompatible: 'Incompatible',
    error: 'Error',
  } as const)[entry.status]
}

export function setExtensionManagementTransportForTests(next: ExtensionManagementTransport | null): void {
  transport = next
  starting = null
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
