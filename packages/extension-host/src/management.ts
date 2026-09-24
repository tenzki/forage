import {
  extensionManagementRequestSchema,
  extensionManagementResponseSchema,
  type ExtensionCatalog,
  type ExtensionCatalogEntry,
  type ExtensionConfiguration,
  type ExtensionDiagnostic,
  type ExtensionManagementRequest,
  type ExtensionManagementResponse,
  type ExtensionSourceConfiguration,
} from '@forage/agent-runtime'
import { ExtensionConfigurationStore } from './configuration'
import { inventoryExtensions } from './inventory'
import { ExtensionPackageLifecycle, type PackageCommandRunner } from './lifecycle'
import { validateForageExtensionEntry } from './runtime'

export interface ExtensionEntryValidator {
  (entry: ExtensionCatalogEntry, configuration: ExtensionSourceConfiguration, signal: AbortSignal): Promise<ExtensionDiagnostic[]>
}

export interface ExtensionManagementServiceOptions {
  configurationRoot?: string
  validationTimeoutMs?: number
  validateEntry?: ExtensionEntryValidator
  commandRunner?: PackageCommandRunner
  createLifecycleId?: (prefix: string) => string
}

export class ExtensionManagementService {
  private readonly store: ExtensionConfigurationStore
  private readonly validationTimeoutMs: number
  private readonly validateEntry: ExtensionEntryValidator
  private readonly lifecycle: ExtensionPackageLifecycle
  private catalog: ExtensionCatalog | undefined

  constructor(options: ExtensionManagementServiceOptions = {}) {
    this.store = new ExtensionConfigurationStore({ root: options.configurationRoot })
    this.validationTimeoutMs = options.validationTimeoutMs ?? 10_000
    this.validateEntry = options.validateEntry ?? (async (entry, configuration) => (
      await validateForageExtensionEntry(entry, configuration)
    ).diagnostics)
    this.lifecycle = new ExtensionPackageLifecycle({
      store: this.store,
      validateEntry: (entry, configuration) => this.boundedValidation(entry, configuration),
      commandRunner: options.commandRunner,
      createId: options.createLifecycleId,
    })
  }

  async handle(raw: unknown): Promise<ExtensionManagementResponse> {
    let request: ExtensionManagementRequest
    try {
      request = extensionManagementRequestSchema.parse(raw)
    } catch {
      throw new Error('Invalid extension management request.')
    }
    try {
      return extensionManagementResponseSchema.parse(await this.dispatch(request))
    } catch (error) {
      return extensionManagementResponseSchema.parse({
        version: 1,
        kind: 'response',
        requestId: request.requestId,
        operation: request.operation,
        ok: false,
        diagnostics: [diagnostic(error)],
      })
    }
  }

  private async dispatch(request: ExtensionManagementRequest): Promise<ExtensionManagementResponse> {
    if (request.operation === 'inventory') {
      await this.store.ensureExtensionsDirectory()
      const configuration = await this.store.read()
      return success(request, {
        catalog: await this.refresh(configuration),
        configuration,
        extensionsDirectory: normalizePath(this.store.extensionsPath),
      })
    }
    if (request.operation === 'install') {
      const installationId = await this.lifecycle.install(request.source, request.previewId)
      return success(request, { entry: await this.requireEntry(installationId, true) })
    }
    if (request.operation === 'preview_install') {
      return success(request, { preview: await this.lifecycle.preview(request.source) })
    }
    if (request.operation === 'remove') {
      const configuration = await this.configurationById(request.installationId)
      await this.lifecycle.remove(configuration)
      await this.refresh()
      return success(request, { removedInstallationId: request.installationId })
    }
    if (request.operation === 'disable') {
      await this.mutateSource(request.installationId, (source) => { source.enabled = false })
      return success(request, { entry: await this.requireEntry(request.installationId, true) })
    }

    const entry = await this.requireEntry(request.installationId, true)
    const configuration = await this.configurationFor(entry)
    if (request.operation === 'check_updates') {
      return success(request, { update: await this.lifecycle.checkForUpdate(configuration) })
    }
    if (request.operation === 'update') {
      await this.lifecycle.update(configuration)
      return success(request, { entry: await this.requireEntry(request.installationId, true) })
    }
    if (request.operation === 'configuration_status') return success(request, { entry, configuration: await this.store.read() })
    if (request.operation === 'configure') {
      assertDeclaredConfiguration(entry, request.settings, request.secretReferences)
      await this.mutateSource(request.installationId, (source) => {
        source.settings = request.settings
        source.secretReferences = request.secretReferences
      })
      return success(request, { entry: await this.requireEntry(request.installationId, true) })
    }
    if (request.operation === 'validate') {
      const diagnostics = await this.boundedValidation(entry, configuration)
      if (diagnostics.length) return failure(request, diagnostics)
      return success(request, { entry })
    }
    if (request.operation === 'enable') {
      const diagnostics = await this.boundedValidation(entry, {
        ...configuration,
        enabled: true,
        trust: { accepted: true, extensionId: entry.manifest?.id },
      })
      if (diagnostics.length) return failure(request, diagnostics)
      await this.activateSource(entry)
      return success(request, { entry: await this.requireEntry(request.installationId, true) })
    }
    if (request.operation === 'reload') {
      const diagnostics = entry.status === 'ready' ? await this.boundedValidation(entry, configuration) : []
      if (diagnostics.length) return failure(request, diagnostics)
      return success(request, { entry })
    }
    throw new Error('Unsupported extension management operation.')
  }

  private async refresh(configuration?: ExtensionConfiguration): Promise<ExtensionCatalog> {
    this.catalog = await inventoryExtensions({ configurationRoot: this.store.root, configuration })
    return this.catalog
  }

  private async requireEntry(installationId: string, refresh = false): Promise<ExtensionCatalogEntry> {
    const catalog = refresh || !this.catalog ? await this.refresh() : this.catalog
    const entry = catalog.entries.find((candidate) => candidate.source.installationId === installationId)
    if (!entry) throw new Error(`Unknown extension installation: ${installationId}`)
    return entry
  }

  private async configurationFor(entry: ExtensionCatalogEntry): Promise<ExtensionSourceConfiguration> {
    const configuration = await this.store.read()
    const configured = configuration.sources.find((source) => source.installationId === entry.source.installationId)
    if (configured) return configured
    return {
      installationId: entry.source.installationId,
      source: { kind: 'local', path: entry.source.canonicalPath },
      enabled: false,
      trust: { accepted: false },
      settings: {},
    }
  }

  private async configurationById(installationId: string): Promise<ExtensionSourceConfiguration> {
    const configuration = await this.store.read()
    const source = configuration.sources.find((candidate) => candidate.installationId === installationId)
    if (!source) throw new Error(`Unknown extension installation: ${installationId}`)
    return source
  }

  private async mutateSource(installationId: string, mutation: (source: ExtensionSourceConfiguration) => void): Promise<void> {
    await this.store.mutate((draft) => {
      const source = draft.sources.find((candidate) => candidate.installationId === installationId)
      if (!source) throw new Error(`Unknown extension installation: ${installationId}`)
      mutation(source)
    })
    await this.refresh()
  }

  private async activateSource(entry: ExtensionCatalogEntry): Promise<void> {
    await this.store.mutate((draft) => {
      let source = draft.sources.find((candidate) => candidate.installationId === entry.source.installationId)
      if (!source) {
        source = {
          installationId: entry.source.installationId,
          source: { kind: 'local', path: entry.source.canonicalPath },
          enabled: false,
          trust: { accepted: false },
          settings: {},
        }
        draft.sources.push(source)
      }
      source.trust = { accepted: true, extensionId: entry.manifest!.id }
      source.enabled = true
    })
    await this.refresh()
  }

  private async boundedValidation(entry: ExtensionCatalogEntry, configuration: ExtensionSourceConfiguration): Promise<ExtensionDiagnostic[]> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort('validation_timeout'), this.validationTimeoutMs)
    try {
      return await Promise.race([
        this.validateEntry(entry, configuration, controller.signal),
        new Promise<ExtensionDiagnostic[]>((resolve) => {
          controller.signal.addEventListener('abort', () => resolve([{
            code: 'validation_timeout', severity: 'error', message: 'Extension validation exceeded the allowed time.',
          }]), { once: true })
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
}

function success(
  request: ExtensionManagementRequest,
  result: ({
    catalog: ExtensionCatalog
    configuration: ExtensionConfiguration
    extensionsDirectory: string
  } | {
    entry: ExtensionCatalogEntry
    configuration?: ExtensionConfiguration
  } | { removedInstallationId: string } | {
    update: { available: boolean; revision?: string }
  } | {
    preview: {
      previewId: string
      requestedSource: import('@forage/agent-runtime').ExtensionSourceRequest
      entry: ExtensionCatalogEntry
    }
  }),
): ExtensionManagementResponse {
  return { version: 1, kind: 'response', requestId: request.requestId, operation: request.operation, ok: true, ...result } as ExtensionManagementResponse
}

function assertDeclaredConfiguration(
  entry: ExtensionCatalogEntry,
  settings: Record<string, string | number | boolean>,
  secretReferences: Record<string, string>,
): void {
  if (!entry.manifest) throw new Error('Only compatible Forage extensions can be configured.')
  const declarations = new Map(entry.manifest.contributes.settings.map((setting) => [setting.key, setting]))
  for (const [key, value] of Object.entries(settings)) {
    const declaration = declarations.get(key)
    if (!declaration || declaration.type === 'secret') throw new Error(`Setting ${key} is not a declared non-secret setting.`)
    const valid = declaration.type === 'number'
      ? typeof value === 'number' && Number.isFinite(value)
        && (declaration.minimum === undefined || value >= declaration.minimum)
        && (declaration.maximum === undefined || value <= declaration.maximum)
      : declaration.type === 'boolean'
        ? typeof value === 'boolean'
        : declaration.type === 'select'
          ? typeof value === 'string' && declaration.options.some((option) => option.value === value)
          : typeof value === 'string'
    if (!valid) throw new Error(`Setting ${key} does not match its manifest declaration.`)
  }
  for (const key of Object.keys(secretReferences)) {
    if (declarations.get(key)?.type !== 'secret') throw new Error(`Secret ${key} is not declared by this extension.`)
  }
}

function normalizePath(value: string): string {
  return value.split('\\').join('/')
}

function failure(request: ExtensionManagementRequest, diagnostics: ExtensionDiagnostic[]): ExtensionManagementResponse {
  return { version: 1, kind: 'response', requestId: request.requestId, operation: request.operation, ok: false, diagnostics }
}

function diagnostic(error: unknown): ExtensionDiagnostic {
  return {
    code: 'management_operation_failed',
    severity: 'error',
    message: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
  }
}
