import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  extensionLogEntrySchema,
  extensionProgressSchema,
  extensionToolInputSchemaSchema,
  extensionToolResultSchema,
  type ExtensionCatalogEntry,
  type ExtensionDiagnostic,
  type ExtensionSourceConfiguration,
  type ExtensionToolResult,
} from '@forage/agent-runtime'
import type {
  ExtensionLogEntry,
  ExtensionProgress,
  ExtensionRunContext,
  ExtensionRunEndContext,
  ExtensionSettingValue,
  ExtensionToolDefinition,
  ForageExtensionHost,
  ForageExtensionSetup,
} from '@forage/extension-api'

const MAX_CONSOLE_CHARS = 2_000

export interface ExtensionRuntimeLog extends ExtensionLogEntry {
  installationId: string
  extensionId: string
}

export interface LoadExtensionOptions {
  configuration?: ExtensionSourceConfiguration
  cacheKey?: string
  stderr?: (line: string) => void
}

export interface ExtensionExecutionOptions {
  signal: AbortSignal
  settings?: Readonly<Record<string, ExtensionSettingValue>>
  secrets?: Readonly<Record<string, string | undefined>>
  onProgress?: (progress: ExtensionProgress) => void
  onLog?: (entry: ExtensionRuntimeLog) => void
}

export interface LoadedForageExtension {
  readonly entry: ExtensionCatalogEntry
  readonly tools: ReadonlyMap<string, ExtensionToolDefinition>
  readonly hookNames: readonly ('run:start' | 'run:end')[]
  executeTool(toolId: string, input: unknown, options: ExtensionExecutionOptions): Promise<ExtensionToolResult>
  runStart(runId: string, options: ExtensionExecutionOptions): Promise<void>
  runEnd(runId: string, outcome: ExtensionRunEndContext['outcome'], options: ExtensionExecutionOptions): Promise<void>
}

export async function runExtensionStartHooks(
  extensions: readonly LoadedForageExtension[],
  runId: string,
  options: ExtensionExecutionOptions,
): Promise<void> {
  for (const extension of extensions) {
    try {
      await extension.runStart(runId, options)
    } catch (error) {
      throw new ExtensionRuntimeError(
        'extension_hook_failed',
        `${extension.entry.manifest?.id ?? extension.entry.source.installationId} run:start failed: ${boundedError(error)}`,
      )
    }
  }
}

export async function runExtensionEndHooks(
  extensions: readonly LoadedForageExtension[],
  runId: string,
  outcome: ExtensionRunEndContext['outcome'],
  options: ExtensionExecutionOptions,
): Promise<void> {
  for (const extension of [...extensions].reverse()) {
    try {
      await extension.runEnd(runId, outcome, options)
    } catch (error) {
      throw new ExtensionRuntimeError(
        'extension_hook_failed',
        `${extension.entry.manifest?.id ?? extension.entry.source.installationId} run:end failed: ${boundedError(error)}`,
      )
    }
  }
}

export class ExtensionRuntimeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ExtensionRuntimeError'
  }
}

export async function loadForageExtension(
  entry: ExtensionCatalogEntry,
  options: LoadExtensionOptions = {},
): Promise<LoadedForageExtension> {
  const manifest = entry.manifest
  const provenance = entry.provenance
  if (!manifest || !provenance) {
    throw new ExtensionRuntimeError('incompatible_extension', 'A compatible manifest and provenance are required before loading an extension.')
  }
  if (!options.configuration?.trust.accepted || options.configuration.trust.extensionId !== manifest.id) {
    throw new ExtensionRuntimeError('extension_not_trusted', 'The extension source has not been trusted for its current identity.')
  }
  await verifyEntryFiles(entry)

  const tools = new Map<string, ExtensionToolDefinition>()
  const hooks = new Map<'run:start' | 'run:end', Array<(context: ExtensionRunContext | ExtensionRunEndContext) => void | Promise<void>>>([
    ['run:start', []],
    ['run:end', []],
  ])
  const host: ForageExtensionHost = {
    registerTool(tool) {
      validateRuntimeTool(tool)
      if (tools.has(tool.id)) throw new ExtensionRuntimeError('duplicate_runtime_tool', `Tool ${tool.id} was registered more than once.`)
      tools.set(tool.id, tool)
    },
    on(event, listener) {
      const registered = hooks.get(event)
      if (!registered || typeof listener !== 'function') {
        throw new ExtensionRuntimeError('unsupported_runtime_contribution', `Unsupported extension hook: ${String(event)}`)
      }
      registered.push(listener as (context: ExtensionRunContext | ExtensionRunEndContext) => void | Promise<void>)
    },
  }

  const entryPath = path.resolve(entry.source.canonicalPath, manifest.entry.slice(2))
  const importUrl = pathToFileURL(entryPath)
  if (options.cacheKey) importUrl.searchParams.set('forageRevision', options.cacheKey)
  const module = await withRedirectedConsole(options.stderr, async () => import(importUrl.href)) as { default?: unknown }
  if (typeof module.default !== 'function') {
    throw new ExtensionRuntimeError('invalid_extension_entry', 'The extension entry must default-export a Forage setup function.')
  }
  await withRedirectedConsole(options.stderr, async () => {
    await (module.default as ForageExtensionSetup)(host)
  })
  assertManifestRuntimeAgreement(entry, tools, hooks)

  const declaredSettings = manifest.contributes.settings
  const baseSettings = configuredSettings(declaredSettings, options.configuration)
  const identity = { installationId: entry.source.installationId, extensionId: manifest.id }
  const executionContext = (execution: ExtensionExecutionOptions) => {
    const settings = Object.freeze({ ...baseSettings, ...(execution.settings ?? {}) })
    const secrets = Object.freeze(declaredSecrets(declaredSettings, execution.secrets ?? {}))
    const log = (raw: ExtensionLogEntry): void => {
      const parsed = extensionLogEntrySchema.parse(raw)
      execution.onLog?.({ ...parsed, ...identity })
    }
    return { settings, secrets, log }
  }

  return Object.freeze({
    entry,
    tools,
    hookNames: [...hooks.entries()].filter(([, listeners]) => listeners.length > 0).map(([name]) => name),
    async executeTool(toolId, input, execution) {
      const tool = tools.get(toolId)
      if (!tool) throw new ExtensionRuntimeError('unknown_extension_tool', `Extension tool ${toolId} is not registered.`)
      execution.signal.throwIfAborted()
      const common = executionContext(execution)
      const result = await withRedirectedConsole(options.stderr, () => tool.execute(input, {
        signal: execution.signal,
        ...common,
        reportProgress(raw) {
          const progress = extensionProgressSchema.parse(raw)
          if (!execution.signal.aborted) execution.onProgress?.(progress)
        },
      }))
      execution.signal.throwIfAborted()
      return extensionToolResultSchema.parse(result)
    },
    async runStart(runId, execution) {
      const common = executionContext(execution)
      for (const listener of hooks.get('run:start')!) {
        execution.signal.throwIfAborted()
        await withRedirectedConsole(options.stderr, () => listener({ runId, signal: execution.signal, ...common }))
      }
    },
    async runEnd(runId, outcome, execution) {
      const common = executionContext(execution)
      for (const listener of hooks.get('run:end')!) {
        await withRedirectedConsole(options.stderr, () => listener({ runId, outcome, signal: execution.signal, ...common }))
      }
    },
  } satisfies LoadedForageExtension)
}

export async function validateForageExtensionEntry(
  entry: ExtensionCatalogEntry,
  configuration: ExtensionSourceConfiguration,
  options: Pick<LoadExtensionOptions, 'stderr'> = {},
): Promise<{ tools: string[]; hooks: string[]; diagnostics: ExtensionDiagnostic[] }> {
  try {
    const loaded = await loadForageExtension(entry, {
      configuration,
      cacheKey: entry.provenance?.entryDigest,
      stderr: options.stderr,
    })
    return { tools: [...loaded.tools.keys()].sort(), hooks: [...loaded.hookNames].sort(), diagnostics: [] }
  } catch (error) {
    return {
      tools: [],
      hooks: [],
      diagnostics: [{
        code: error instanceof ExtensionRuntimeError ? error.code : 'entry_validation_failed',
        severity: 'error',
        message: boundedError(error),
      }],
    }
  }
}

export function sanitizeExtensionText(value: string, secrets: readonly string[]): string {
  return secrets.filter(Boolean).reduce((text, secret) => text.split(secret).join('[REDACTED]'), value).slice(0, MAX_CONSOLE_CHARS)
}

async function verifyEntryFiles(entry: ExtensionCatalogEntry): Promise<void> {
  const manifest = entry.manifest!
  const provenance = entry.provenance!
  const root = await realpath(entry.source.canonicalPath)
  const manifestPath = await realpath(path.join(root, 'forage.extension.json'))
  const entryPath = await realpath(path.resolve(root, manifest.entry.slice(2)))
  if (!isWithin(root, manifestPath) || !isWithin(root, entryPath) || !(await stat(entryPath)).isFile()) {
    throw new ExtensionRuntimeError('source_ownership_changed', 'The admitted extension path no longer belongs to its source directory.')
  }
  const sourceRevision = sha256(await readFile(manifestPath))
  const entryDigest = sha256(await readFile(entryPath))
  if (sourceRevision !== provenance.sourceRevision || entryDigest !== provenance.entryDigest) {
    throw new ExtensionRuntimeError('stale_extension_revision', 'Extension files changed after admission; reload and retry against the current catalog.')
  }
}

function validateRuntimeTool(tool: ExtensionToolDefinition): void {
  if (!tool || typeof tool !== 'object') throw new ExtensionRuntimeError('invalid_runtime_tool', 'Registered tools must be objects.')
  if (typeof tool.id !== 'string' || typeof tool.name !== 'string' || typeof tool.description !== 'string' || typeof tool.execute !== 'function') {
    throw new ExtensionRuntimeError('invalid_runtime_tool', 'A registered tool is missing required fields.')
  }
  extensionToolInputSchemaSchema.parse(tool.inputSchema)
  assertSupportedSchema(tool.inputSchema)
}

function assertSupportedSchema(value: unknown, depth = 0): void {
  if (depth > 8 || !value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ExtensionRuntimeError('unsupported_tool_schema', 'Tool schemas must be bounded JSON Schema objects.')
  }
  const schema = value as Record<string, unknown>
  const allowed = new Set(['type', 'properties', 'required', 'additionalProperties', 'description', 'enum', 'items', 'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems'])
  if (Object.keys(schema).some((key) => !allowed.has(key))) {
    throw new ExtensionRuntimeError('unsupported_tool_schema', 'The tool schema uses unsupported JSON Schema keywords.')
  }
  const type = schema.type
  if (!['object', 'string', 'number', 'integer', 'boolean', 'array'].includes(String(type))) {
    throw new ExtensionRuntimeError('unsupported_tool_schema', 'The tool schema uses an unsupported type.')
  }
  if (type === 'object') {
    if (schema.additionalProperties !== false || !schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) {
      throw new ExtensionRuntimeError('unsupported_tool_schema', 'Object tool schemas require properties and additionalProperties: false.')
    }
    for (const property of Object.values(schema.properties as Record<string, unknown>)) assertSupportedSchema(property, depth + 1)
  }
  if (type === 'array') {
    if (!schema.items || typeof schema.maxItems !== 'number') {
      throw new ExtensionRuntimeError('unsupported_tool_schema', 'Array tool schemas require items and maxItems.')
    }
    assertSupportedSchema(schema.items, depth + 1)
  }
}

function assertManifestRuntimeAgreement(
  entry: ExtensionCatalogEntry,
  tools: ReadonlyMap<string, ExtensionToolDefinition>,
  hooks: ReadonlyMap<string, readonly unknown[]>,
): void {
  const manifest = entry.manifest!
  const declaredTools = manifest.contributes.tools.map((tool) => tool.id).sort()
  const runtimeTools = [...tools.keys()].sort()
  const declaredHooks = [...manifest.contributes.hooks].sort()
  const runtimeHooks = [...hooks.entries()].filter(([, listeners]) => listeners.length > 0).map(([name]) => name).sort()
  if (JSON.stringify(declaredTools) !== JSON.stringify(runtimeTools)) {
    throw new ExtensionRuntimeError('manifest_runtime_tool_mismatch', 'Runtime tool registrations must exactly match the manifest declarations.')
  }
  if (JSON.stringify(declaredHooks) !== JSON.stringify(runtimeHooks)) {
    throw new ExtensionRuntimeError('manifest_runtime_hook_mismatch', 'Runtime hook registrations must exactly match the manifest declarations.')
  }
  for (const declaration of manifest.contributes.tools) {
    const tool = tools.get(declaration.id)!
    if (tool.name !== declaration.name || tool.description !== declaration.description) {
      throw new ExtensionRuntimeError('manifest_runtime_tool_mismatch', `Runtime metadata for ${declaration.id} does not match its manifest declaration.`)
    }
  }
}

function configuredSettings(
  declarations: NonNullable<ExtensionCatalogEntry['manifest']>['contributes']['settings'],
  configuration?: ExtensionSourceConfiguration,
): Record<string, ExtensionSettingValue> {
  const output: Record<string, ExtensionSettingValue> = {}
  for (const declaration of declarations) {
    if (declaration.type === 'secret') continue
    const configured = configuration?.settings[declaration.key]
    if (configured !== undefined) output[declaration.key] = configured
    else if ('default' in declaration && declaration.default !== undefined) output[declaration.key] = declaration.default
  }
  return output
}

function declaredSecrets(
  declarations: NonNullable<ExtensionCatalogEntry['manifest']>['contributes']['settings'],
  values: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return Object.fromEntries(declarations.filter((setting) => setting.type === 'secret').map((setting) => [setting.key, values[setting.key]]))
}

async function withRedirectedConsole<T>(stderr: ((line: string) => void) | undefined, operation: () => T | Promise<T>): Promise<T> {
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug }
  const write = (...values: unknown[]) => (stderr ?? ((line) => process.stderr.write(`${line}\n`)))(values.map(stringifyConsole).join(' ').slice(0, MAX_CONSOLE_CHARS))
  Object.assign(console, { log: write, info: write, warn: write, error: write, debug: write })
  try {
    return await operation()
  } finally {
    Object.assign(console, original)
  }
}

function stringifyConsole(value: unknown): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) } catch { return String(value) }
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000) || 'Extension validation failed.'
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}
