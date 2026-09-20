import { createHash } from 'node:crypto'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  RESERVED_EXTENSION_TOOL_IDS,
  extensionCatalogSchema,
  extensionSourceSchema,
  parseExtensionManifest,
  resolveExtensionExecutorAvailability,
  resolveExtensionToolAvailability,
  type ExtensionCatalog,
  type ExtensionCatalogEntry,
  type ExtensionConfiguration,
  type ExtensionDiagnostic,
  type ExtensionSource,
} from '@forage/agent-runtime'
import {
  ExtensionConfigurationStore,
  canonicalizeExtensionDirectory,
  resolveConfiguredPath,
} from './configuration'

const MANIFEST_FILE = 'forage.extension.json'

export interface InventoryOptions {
  configurationRoot?: string
  configuration?: ExtensionConfiguration
  customHttpToolIds?: readonly string[]
}

interface InventoryCandidate {
  source: ExtensionSource
  configuration?: ExtensionConfiguration['sources'][number]
}

export async function inventoryExtensions(options: InventoryOptions = {}): Promise<ExtensionCatalog> {
  const store = new ExtensionConfigurationStore({ root: options.configurationRoot })
  const configuration = options.configuration ?? await store.read()
  const configuredCandidates = await configuredSources(store.root, configuration)
  const configuredPaths = new Set(configuredCandidates.map((candidate) => candidate.source.canonicalPath))
  const dropInCandidates = (await dropInSources(store.extensionsPath))
    .filter((candidate) => !configuredPaths.has(candidate.source.canonicalPath))
  const candidates = [...configuredCandidates, ...dropInCandidates]
    .sort((left, right) => left.source.installationId.localeCompare(right.source.installationId))
  const entries = await Promise.all(candidates.map((candidate) => inspectExtensionSource(candidate.source, candidate.configuration)))
  const resolvedEntries = applyStaticAvailability(entries, options.customHttpToolIds ?? [])
  const revision = sha256(JSON.stringify(resolvedEntries))
  return extensionCatalogSchema.parse({ version: 1, revision, entries: resolvedEntries })
}

async function configuredSources(
  configurationRoot: string,
  configuration: ExtensionConfiguration,
): Promise<InventoryCandidate[]> {
  const output: InventoryCandidate[] = []
  const seenPaths = new Set<string>()
  for (const configured of configuration.sources) {
    let source: ExtensionSource
    if (configured.source.kind === 'local') {
      let canonicalPath: string
      try {
        canonicalPath = await canonicalizeExtensionDirectory(configurationRoot, configured.source.path)
      } catch {
        canonicalPath = normalizeAbsolutePath(resolveConfiguredPath(configurationRoot, configured.source.path))
      }
      source = extensionSourceSchema.parse({
        kind: 'local',
        installationId: configured.installationId,
        requestedPath: configured.source.path,
        canonicalPath,
      })
    } else {
      if (!configured.resolvedSource) continue
      let canonicalPath = configured.resolvedSource.canonicalPath
      try {
        canonicalPath = await canonicalizeExtensionDirectory(configurationRoot, canonicalPath)
      } catch {
        canonicalPath = normalizeAbsolutePath(path.resolve(canonicalPath))
      }
      source = extensionSourceSchema.parse({ ...configured.resolvedSource, canonicalPath })
    }
    if (seenPaths.has(source.canonicalPath)) continue
    seenPaths.add(source.canonicalPath)
    output.push({ source, configuration: configured })
  }
  return output
}

async function dropInSources(extensionsPath: string): Promise<InventoryCandidate[]> {
  let directoryEntries
  try {
    directoryEntries = await readdir(extensionsPath, { withFileTypes: true })
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return []
    throw error
  }

  const output: InventoryCandidate[] = []
  for (const entry of directoryEntries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue
    const candidatePath = path.join(extensionsPath, entry.name)
    if (!await fileExists(path.join(candidatePath, MANIFEST_FILE))) continue
    const canonicalPath = normalizeAbsolutePath(await realpath(candidatePath))
    output.push({
      source: extensionSourceSchema.parse({
        kind: 'drop-in',
        installationId: `dropin-${sha256(canonicalPath).slice(0, 24)}`,
        directoryName: entry.name,
        canonicalPath,
      }),
    })
  }
  return output
}

export async function inspectExtensionSource(
  source: ExtensionSource,
  configuration?: ExtensionConfiguration['sources'][number],
): Promise<ExtensionCatalogEntry> {
  const candidate: InventoryCandidate = { source, configuration }
  const diagnostics: ExtensionDiagnostic[] = []
  const sourceRoot = candidate.source.canonicalPath
  const manifestPath = path.join(sourceRoot, MANIFEST_FILE)
  let serialized: string
  try {
    const canonicalManifestPath = normalizeAbsolutePath(await realpath(manifestPath))
    if (!isWithin(sourceRoot, canonicalManifestPath)) {
      return errorEntry(candidate.source, diagnostic('manifest_path_escape', 'Extension manifest resolves outside its source directory.'))
    }
    serialized = await readFile(canonicalManifestPath, 'utf8')
  } catch (error) {
    return errorEntry(
      candidate.source,
      diagnostic(
        'missing_manifest',
        isNodeError(error) && error.code === 'ENOENT'
          ? 'The source does not contain forage.extension.json; Pi-only packages and loose files are not Forage extensions.'
          : 'The extension manifest could not be read.',
      ),
    )
  }

  let manifest: NonNullable<ExtensionCatalogEntry['manifest']>
  try {
    manifest = parseExtensionManifest(serialized)
  } catch {
    return errorEntry(candidate.source, diagnostic(
      'invalid_manifest',
      'forage.extension.json does not match the current Forage extension contract.',
    ))
  }

  const sourceRevision = sha256(serialized)
  const provenance = {
    installationId: candidate.source.installationId,
    extensionId: manifest.id,
    sourceKind: candidate.source.kind,
    sourceRevision,
  } as const
  if (candidate.source.kind !== 'local' && manifest.entry.endsWith('.ts')) {
    diagnostics.push(diagnostic(
      'typescript_entry_requires_local_source',
      'TypeScript entry points are supported only for explicitly registered local development sources.',
      manifest.entry,
    ))
  }

  let entryDigest: string | undefined
  try {
    const entryPath = path.resolve(sourceRoot, manifest.entry.slice(2))
    const canonicalEntryPath = normalizeAbsolutePath(await realpath(entryPath))
    if (!isWithin(sourceRoot, canonicalEntryPath)) {
      diagnostics.push(diagnostic('entry_path_escape', 'The extension entry resolves outside its source directory.', manifest.entry))
    } else {
      const metadata = await stat(canonicalEntryPath)
      if (!metadata.isFile()) {
        diagnostics.push(diagnostic('invalid_entry', 'The extension entry is not a file.', manifest.entry))
      } else {
        entryDigest = sha256(await readFile(canonicalEntryPath))
      }
    }
  } catch {
    diagnostics.push(diagnostic('missing_entry', 'The declared extension entry does not exist.', manifest.entry))
  }

  if (candidate.configuration?.trust.accepted
    && candidate.configuration.trust.extensionId !== manifest.id) {
    diagnostics.push(diagnostic(
      'trust_identity_mismatch',
      'The manifest identity no longer matches the identity accepted for this source.',
    ))
  }

  const configurationDiagnostics = validateConfiguredSettings(candidate.configuration, manifest)
  diagnostics.push(...configurationDiagnostics)
  const staticError = diagnostics.some((item) => item.severity === 'error')
  const status = staticError
    ? 'error'
    : !candidate.configuration || !candidate.configuration.trust.accepted
      ? 'needs_review'
      : !candidate.configuration.enabled
        ? 'disabled'
        : configurationDiagnostics.length > 0
          ? 'needs_configuration'
          : 'ready'

  return extensionCatalogEntry(candidate, {
    manifest,
    provenance: { ...provenance, ...(entryDigest ? { entryDigest } : {}) },
    status,
    diagnostics,
  })
}

function extensionCatalogEntry(
  candidate: InventoryCandidate,
  value: {
    manifest?: ExtensionCatalogEntry['manifest']
    provenance: ExtensionCatalogEntry['provenance']
    status: ExtensionCatalogEntry['status']
    diagnostics: ExtensionDiagnostic[]
  },
): ExtensionCatalogEntry {
  const declaration = value.manifest!
  return extensionCatalogSchema.shape.entries.element.parse({
    source: candidate.source,
    ...value,
    tools: declaration.contributes.tools.map((tool) => ({
      ...tool,
      available: value.status === 'ready',
      globallyAuthorized: false,
      diagnostics: value.status === 'ready' ? [] : value.diagnostics,
    })),
    executors: declaredExecutors(declaration).map((executor) => ({
      ...executor,
      available: value.status === 'ready',
      diagnostics: value.status === 'ready' ? [] : value.diagnostics,
    })),
  })
}

function errorEntry(source: ExtensionSource, ...diagnostics: ExtensionDiagnostic[]): ExtensionCatalogEntry {
  return extensionCatalogSchema.shape.entries.element.parse({
    source,
    status: 'error',
    tools: [],
    executors: [],
    diagnostics,
  })
}

function validateConfiguredSettings(
  configuration: InventoryCandidate['configuration'],
  manifest: ExtensionCatalogEntry['manifest'],
): ExtensionDiagnostic[] {
  if (!configuration || !manifest) return []
  const diagnostics: ExtensionDiagnostic[] = []
  const declarations = new Map(manifest.contributes.settings.map((setting) => [setting.key, setting]))
  for (const key of Object.keys(configuration.settings)) {
    const declaration = declarations.get(key)
    if (!declaration || declaration.type === 'secret') {
      diagnostics.push(diagnostic('invalid_setting', `Stored setting ${key} is not a declared non-secret setting.`, key))
      continue
    }
    const value = configuration.settings[key]
    if (!settingValueIsValid(declaration, value)) {
      diagnostics.push(diagnostic('invalid_setting', `Stored setting ${key} does not match its declaration.`, key))
    }
  }
  for (const key of Object.keys(configuration.secretReferences ?? {})) {
    if (declarations.get(key)?.type !== 'secret') {
      diagnostics.push(diagnostic('invalid_secret_reference', `Stored secret reference ${key} is not declared as secret.`, key))
    }
  }
  for (const declaration of manifest.contributes.settings) {
    if (!declaration.required) continue
    const configured = declaration.type === 'secret'
      ? configuration.secretReferences?.[declaration.key] !== undefined
      : configuration.settings[declaration.key] !== undefined || 'default' in declaration
    if (!configured) {
      diagnostics.push({
        code: 'missing_required_setting',
        severity: 'warning',
        message: `Required setting ${declaration.key} is not configured.`,
        path: declaration.key,
      })
    }
  }
  return diagnostics
}

function settingValueIsValid(
  declaration: NonNullable<ExtensionCatalogEntry['manifest']>['contributes']['settings'][number],
  value: string | number | boolean | undefined,
): boolean {
  switch (declaration.type) {
    case 'string':
    case 'multiline':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number'
        && Number.isFinite(value)
        && (declaration.minimum === undefined || value >= declaration.minimum)
        && (declaration.maximum === undefined || value <= declaration.maximum)
    case 'boolean':
      return typeof value === 'boolean'
    case 'select':
      return typeof value === 'string' && declaration.options.some((option) => option.value === value)
    case 'secret':
      return false
  }
}

function applyStaticAvailability(
  entries: ExtensionCatalogEntry[],
  customHttpToolIds: readonly string[],
): ExtensionCatalogEntry[] {
  const readyEntries = entries.filter((entry) => entry.status === 'ready' && entry.manifest)
  const availability = resolveExtensionToolAvailability(readyEntries.map((entry) => ({
    installationId: entry.source.installationId,
    extensionId: entry.manifest!.id,
    toolIds: entry.manifest!.contributes.tools.map((tool) => tool.id),
  })), customHttpToolIds)
  const availabilityByTool = new Map(availability.map((item) => [`${item.installationId}:${item.toolId}`, item]))
  const executorAvailability = resolveExtensionExecutorAvailability(readyEntries.map((entry) => ({
    installationId: entry.source.installationId,
    extensionId: entry.manifest!.id,
    executorIds: declaredExecutors(entry.manifest!).map((executor) => executor.id),
  })))
  const availabilityByExecutor = new Map(executorAvailability.map((item) => [`${item.installationId}:${item.executorId}`, item]))
  const reserved = new Set<string>(RESERVED_EXTENSION_TOOL_IDS)

  return entries.map((entry) => {
    let hasCollision = false
    const tools = entry.tools.map((tool) => {
      const item = availabilityByTool.get(`${entry.source.installationId}:${tool.id}`)
      const reservedDiagnostic = reserved.has(tool.id)
        ? diagnostic('reserved_tool_id', `Tool ${tool.id} is reserved by Forage.`, undefined, tool.id)
        : undefined
      const collisionDiagnostic = item && !item.available
        ? diagnostic(item.diagnosticCode ?? 'tool_collision', `Tool ${tool.id} conflicts with another provider.`, undefined, tool.id)
        : undefined
      const toolDiagnostic = reservedDiagnostic ?? collisionDiagnostic
      if (toolDiagnostic) hasCollision = true
      return {
        ...tool,
        available: tool.available && !toolDiagnostic,
        diagnostics: toolDiagnostic ? [...tool.diagnostics, toolDiagnostic] : tool.diagnostics,
      }
    })
    const executors = (entry.executors ?? []).map((executor) => {
      const item = availabilityByExecutor.get(`${entry.source.installationId}:${executor.id}`)
      const executorDiagnostic = item && !item.available
        ? diagnostic(
          item.diagnosticCode ?? 'executor_collision',
          `Skill executor ${entry.manifest?.id ?? entry.source.installationId}/${executor.id} conflicts with another active installation.`,
          undefined,
          undefined,
          executor.id,
        )
        : undefined
      if (executorDiagnostic) hasCollision = true
      return {
        ...executor,
        available: executor.available && !executorDiagnostic,
        diagnostics: executorDiagnostic ? [...executor.diagnostics, executorDiagnostic] : executor.diagnostics,
      }
    })
    if (!hasCollision) return entry
    const addedDiagnostics = [...tools.flatMap((tool) => tool.diagnostics), ...executors.flatMap((executor) => executor.diagnostics)]
      .filter((item) => !entry.diagnostics.some((existing) => (
        existing.code === item.code && existing.toolId === item.toolId && existing.executorId === item.executorId
      )))
    return extensionCatalogSchema.shape.entries.element.parse({
      ...entry,
      status: entry.status === 'ready' ? 'error' : entry.status,
      tools,
      executors,
      diagnostics: [...entry.diagnostics, ...addedDiagnostics],
    })
  })
}

function diagnostic(
  code: string,
  message: string,
  diagnosticPath?: string,
  toolId?: string,
  executorId?: string,
): ExtensionDiagnostic {
  return {
    code,
    severity: 'error',
    message,
    ...(diagnosticPath ? { path: diagnosticPath } : {}),
    ...(toolId ? { toolId } : {}),
    ...(executorId ? { executorId } : {}),
  }
}

function declaredExecutors(
  declaration: NonNullable<ExtensionCatalogEntry['manifest']>,
) {
  return declaration.contributes.executors ?? []
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function normalizeAbsolutePath(value: string): string {
  return value.split(path.sep).join('/')
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const metadata = await stat(filePath)
    return metadata.isFile()
  } catch {
    return false
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
